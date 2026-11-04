// hud 子系统（ctx 模式：initX(ctx) 注册本子系统函数，Phase A 调用）
import { el, escapeHtml } from './dom.js';
import { getPhysViewport, detectCoordSemantics, _fixedVisual, positionPhysical, detectScreenMode } from './viewport.js';
import { makePointerDrag } from './drag.js';

export function initHud(ctx) {
  ctx.attachHudDrag = function () {
      if (!ctx.hud || ctx.hud.__dragBound) return;
      ctx.hud.__dragBound = true;
      // HUD 本体永远 pointer-events:none（不拦截页面交互——盖住弹出菜单/页面元素时，下方仍可 hover/点击选择）；
      // 拖动只走右上角抓手 .dbg-hud-grip（pointer-events:auto，touch-action:none 见 dom.js）。
      // 公共手势工具 makePointerDrag（PointerEvent 覆盖鼠标/触屏/笔，不再需要 touch 事件兜底）。
      ctx._hudDragCtl = makePointerDrag({
        handle: ctx.hud, threshold: 4, capture: 'now',
        filter: function (e) { return !!(e.target && e.target.closest && e.target.closest('.dbg-hud-grip')); },
        onStart: function (e) {
          e.stopPropagation();
          var hv = ctx.hud.__vis || { left: 0, top: 0 };
          var cl = detectCoordSemantics(ctx.hud, e.clientX);
          var s = cl ? (getPhysViewport().scale) : 1;
          return { ox: e.clientX * s - hv.left, oy: e.clientY * s - hv.top, coordLayout: cl };
        },
        onMove: function (ev, st) {
          // 拖动位置按视觉 px（×scale）——与 updateHud/applyHudZoom 同一坐标系，屏幕缩放（页面缩放/移动端 layout 缩放）跟手不漂移
          var vp = getPhysViewport();
          // clientX/Y 按检测语义换算视觉（布局源 ×scale）——ox 恒视觉偏移，1:1 跟手
          var sx = st.coordLayout ? vp.scale : 1;
          var sy = st.coordLayout ? vp.scaleY : 1;
          var visX = ev.clientX * sx - st.ox;
          var visY = ev.clientY * sy - st.oy;
          ctx.hud.__vis = { left: visX, top: visY }; // 视觉目标（positionPhysical 换算布局 + counter-zoom + vv.offset 补偿）
          positionPhysical(ctx.hud, visX, visY, vp.scale, vp.scaleY); // 统一物理固定（拖动中保持 counter-zoom 不置 none）
          ctx.hudUserPos = { x: visX, y: visY }; // 视觉 px（拖动即固定，不跟随选区）
        },
      });
      }

  ctx.resetHudPos = function () {
      ctx.hudUserPos = null;
      if (ctx._hudDragCtl) ctx._hudDragCtl.cancel(); // 进行中的拖动手势也结束（后续 move 不再生效）
      }

  ctx.updateHud = function (p, source) {
      ctx.lastHud = { p: p, source: source };
      // 退出 Inspect（外部 Inspector / AI 点选）后不再重建 HUD：迟到的选区消息会误触 updateHud
      // 重建残留（opacity:0 残骸或复活显示，挡下方点击/观感残留）；点选/hover 快选/模拟 hover 进行中才显示
      if (!ctx.inspectorOn && !ctx.aiInspectActive && !ctx.hudHoverOn) return;
      if (!ctx.hud) { ctx.hud = el('div', { class: 'dbg-hud' }); ctx.root.appendChild(ctx.hud); ctx.attachHudDrag(); }
      // 多行完整信息（hover popup 同款）：tag/尺寸/文本/色号/字体/组件/文件/路径
      // 每行 display:block + nowrap + ellipsis（不折行，超宽省略）——信息全且不乱
      var rowHtml = function (s) { return '<span style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%">' + s + '</span>'; };
      var rows = [];
      var head = '<b>🎯 点击选择</b> <b>&lt;' + (p.tag || '?') + '&gt;</b>';
      if (p.rect) head += ' <i>' + p.rect.w + '×' + p.rect.h + '</i>';
      rows.push(rowHtml(head));
      if (p.text) rows.push(rowHtml('“' + escapeHtml(p.text.trim().slice(0, 60)) + '”'));
      var colors = [];
      if (p.bg && p.bg !== 'rgba(0, 0, 0, 0)') colors.push('bg <i>' + escapeHtml(p.bg) + '</i>');
      if (p.color) colors.push('fg <i>' + escapeHtml(p.color) + '</i>');
      if (p.fontSize) colors.push('font <i>' + escapeHtml(p.fontSize) + '</i>');
      if (colors.length) rows.push(rowHtml(colors.join(' · ')));
      if (p.component || p.file) {
        // 完整路径 + 行号：折行 + word-break（不 ellipsis 截断——有空间就显示全）
        var _fl = (p.component ? p.component + ' · ' : '');
        if (p.file) _fl += '<a class="dbg-open-file" data-file="' + escapeHtml(p.file).replace(/"/g, '&quot;') + '" data-line="' + (p.line || '') + '" title="点击在后台打开">' + escapeHtml(p.file) + (p.line ? ':' + p.line : '') + '</a>';
        if (p.usedAt && (p.usedAt.file || p.usedAt.component)) {
          if (p.usedAt.file) {
            _fl += ' ← 调用于 <a class="dbg-open-file" data-file="' + escapeHtml(p.usedAt.file).replace(/"/g, '&quot;') + '" data-line="' + (p.usedAt.line || '') + '" title="点击在后台打开">' + escapeHtml(p.usedAt.file) + ':' + (p.usedAt.line || '') + '</a>';
          } else if (p.usedAt.component) {
            // 构建未注入源码路径（__file 缺失）：只显示调用组件名
            _fl += ' ← 调用于 ' + escapeHtml(p.usedAt.component);
          }
        }
        rows.push('<span style="display:block;white-space:pre-wrap;word-break:break-all;max-width:100%">📄 ' + _fl + '</span>');
      }
      if (p.xpath) rows.push(rowHtml('<span class="dbg-hud-path">' + escapeHtml(p.xpath) + '</span>'));
      ctx.hud.innerHTML = rows.join('');
      // 右上角抓手：HUD 本体 pointer-events:none 不拦页面，拖动仅通过抓手（innerHTML 每次重写后重新附加）
      if (!ctx.hud.querySelector('.dbg-hud-grip')) {
        ctx.hud.appendChild(el('span', { class: 'dbg-hud-grip', title: '拖动固定 HUD（不跟随选区）' }, ['⠿']));
      }
      // 定位：优先选区下方（箭头指向选区上方）；工具条在选区下方时 HUD 翻上方；底部空间不足也翻上方
      // 用户拖动后位置固定（hudUserPos 非空不自动定位——保持用户拖到的位置）
      if (p.rect && !ctx.hudUserPos && Date.now() > ctx.navHoldT) {
        // 导航切换选区中（navHoldT 窗口内）：HUD 保持当前位置，不跟随新选区（内容已更新）
        var vp = getPhysViewport(); // 视觉视口（scale×inner）——HUD 定位/尺寸全部用视觉 px，counter-zoom 不混布局
        // ---- 小屏（设备物理 <768，用户缩放不变）：HUD 单独放页面底部（不贴合元素），撑开页面流出空间避免覆盖 ----
        if (detectScreenMode().small) {
          var hh = ctx.hud.offsetHeight || 40;
          var hw = ctx.hud.offsetWidth || 200;
          var left = Math.max(8, (vp.w - hw) / 2);
          var top = Math.max(8, vp.h - hh - 8);
          // HUD 闪避：元素在屏幕内但被底部 HUD 遮挡（元素底部进入 HUD 顶部区域）→ HUD 移到元素上方
          //  （用户实测：导航/点选到底部附近元素，元素可见但被固定底部 HUD 盖住）
          try {
            if (p.rect) {
              var _mx = _fixedVisual ? 1 : vp.scale, _my = _fixedVisual ? 1 : vp.scaleY;
              var _ey = p.rect.y * _my, _eh = (p.rect.h || 0) * _my, _ex = p.rect.x * _mx;
              if (source !== 'self') {
                var _fo2 = ctx.frameOffset(source);
                _ex += _fo2.left * _mx; _ey += _fo2.top * _my; // iframe 宿主偏移（布局→视觉）
              }
              var _hudTop = vp.h - hh - 8; // 底部 HUD 视觉顶部
              if (_ey + _eh > _hudTop - 6 && _ey < vp.h - 6) {
                top = Math.max(8, _ey - hh - 8); // 闪避到元素上方（完整露出元素）
              }
            }
          } catch (e) {}
          if (!ctx.hud.__openFileBound) {
        ctx.hud.__openFileBound = true;
        ctx.hud.addEventListener('click', function (ev) {
          var a = ev.target && ev.target.closest ? ev.target.closest('.dbg-open-file') : null;
          if (a) { ev.stopPropagation(); ctx.openFileAt(a.getAttribute('data-file'), parseInt(a.getAttribute('data-line'), 10) || null); }
        });
      }
      ctx.hud.__vis = { left: left, top: top };
          ctx.hud.style.top = top + 'px';
          ctx.hud.style.left = left + 'px';
          ctx.hud.style.maxWidth = (vp.w - 16) + 'px';
          ctx.hud.style.maxHeight = (vp.h - 16) + 'px';
          ctx.hud.style.transform = 'none';
          ctx.applyHudZoom();
          ctx.hud.style.pointerEvents = 'none'; // 小屏不拖动（没有移动问题）
          // 撑开宿主页面底部空间（paddingBottom）——HUD 不覆盖页面内容
          document.body.style.paddingBottom = (hh * (1 / (window.visualViewport ? window.visualViewport.scale : 1))) + 'px';
          ctx.hud.style.opacity = '1';
          return;
        }
        var offX = 0, offY = 0;
        if (source !== 'self') {
          var fo = ctx.frameOffset(source);
          offX = fo.left; offY = fo.top;
        }
        // 视觉坐标：布局坐标 × scale（target iframe 坐标 + iframe 宿主偏移）
        var x = (p.rect.x + offX) * vp.scale, y = (p.rect.y + offY) * vp.scale;
        var elW = (p.rect.w || 0) * vp.scale, elH = (p.rect.h || 0) * vp.scale;
        ctx.hud.style.maxWidth = 'none'; // 单行：宽自适应内容（不压缩折行）
        ctx.hud.style.whiteSpace = 'nowrap';
        // HUD 视觉尺寸：offsetWidth/Height = 视觉尺寸（transform scale(1/scale) 抵消页面缩放）
        var hudH = ctx.hud.offsetHeight;
        if (!hudH || hudH < 24) hudH = 24;
        var hudW = ctx.hud.offsetWidth || 200;
        var gap = 8; // 与选区间距
        var below = y + elH + gap;        // 选区下方
        var above = y - hudH - gap;       // 选区上方
        // 与工具条互斥：工具条显示且在选区下方 → HUD 翻选区上方（不被工具条盖）
        var tbEl = ctx.root.querySelector('.dbg-toolbar');
        var tbOn = tbEl && tbEl.classList.contains('dbg-on');
        var tbTopN = tbOn ? ((parseFloat(tbEl.style.top) || 0) * vp.scale) : 0;
        var toolbarBelowSel = tbOn && tbTopN >= y - 2;
        // 贴合优先级：① 下方完整可见（不超屏、不撞工具条）→ ② 上方完整可见 → ③ 避不开才重叠（clamp 屏内）
        var belowOk = !toolbarBelowSel && below >= 4 && below + hudH <= vp.h - 4;
        var aboveOk = above >= 4 && above + hudH <= vp.h - 4;
        var top;
        if (belowOk) {
          top = below;
          ctx.hud.classList.remove('dbg-hud-up'); // 箭头朝下指向选区上方
        } else if (aboveOk) {
          top = above;
          ctx.hud.classList.add('dbg-hud-up'); // 箭头在底部（指向下方选区）
        } else {
          // 避不开（元素过大/上下都不够）：重叠但保证完整可见——优先贴上方（above ≥4 时），否则贴下方
          top = (above >= 4) ? above : Math.min(Math.max(4, below), vp.h - hudH - 4);
          ctx.hud.classList.add('dbg-hud-up');
        }
        // 绝对 clamp：HUD 完整在视口内（不超屏）
        top = Math.min(Math.max(4, top), Math.max(4, vp.h - hudH - 4));
        ctx.hud.style.maxHeight = (vp.h - 8) + 'px';
        // 水平：以鼠标位置为中心，clamp 视口内（完整可见）
        var mouseX = (typeof p.mouseX === 'number') ? ((p.mouseX + offX) * vp.scale) : (x + elW / 2);
        var left = mouseX - hudW / 2;
        left = Math.min(Math.max(4, left), Math.max(4, vp.w - hudW - 4));
        if (!ctx.hud.__openFileBound) {
        ctx.hud.__openFileBound = true;
        ctx.hud.addEventListener('click', function (ev) {
          var a = ev.target && ev.target.closest ? ev.target.closest('.dbg-open-file') : null;
          if (a) { ev.stopPropagation(); ctx.openFileAt(a.getAttribute('data-file'), parseInt(a.getAttribute('data-line'), 10) || null); }
        });
      }
      ctx.hud.__vis = { left: left, top: top }; // 视觉目标（缩放换算基准）
        ctx.hud.style.top = top + 'px';
        var maxHudW = vp.w - 16; // 视口内最大宽（完整可见，不超屏）
        ctx.hud.style.maxWidth = maxHudW + 'px';
        ctx.hud.style.whiteSpace = 'nowrap';
        ctx.hud.style.overflowX = 'hidden';
        ctx.hud.style.overflowY = 'auto';
        ctx.hud.style.textOverflow = 'ellipsis';
        ctx.hud.style.left = left + 'px';
        ctx.hud.style.transform = 'none';
        ctx.applyHudZoom(); // 缩放换算（真实屏幕尺寸）
      } else if (p.rect) {
        // 大屏/拖动：清除小屏撑开的空间（不残留 padding）
        if (document.body.style.paddingBottom) document.body.style.paddingBottom = '';
      }
      ctx.hud.style.opacity = '1';
      }

  ctx.applyHudZoom = function () {
      var vp = getPhysViewport();
      if (!ctx.hud || !ctx.hud.__vis) return;
      positionPhysical(ctx.hud, ctx.hud.__vis.left, ctx.hud.__vis.top, vp.scale, vp.scaleY);
      }

  ctx.hideHud = function () {
      if (ctx.hud) {
        ctx.hud.style.opacity = '0';
        ctx.hud.style.pointerEvents = 'none'; // 隐藏彻底不拦截（否则透明但可点击，挡住 HUD 下方按钮）
      }
      }
}
