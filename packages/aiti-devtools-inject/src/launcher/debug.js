// debug 子系统（ctx 模式：initX(ctx) 注册本子系统函数，Phase A 调用）
import { el } from './dom.js';
import { getPhysViewport, _fixedVisual, positionPhysical, visToCss, capVisW, detectScreenMode } from './viewport.js';
import { DBG_SHOW_KEY } from './constants.js';
import { lsGetString, lsSetString } from './storage.js';
import { t } from './i18n.js';

export function initDebug(ctx) {
  ctx.loadShowDebug = function () { return lsGetString(DBG_SHOW_KEY, '') === 'on';   }

  ctx.saveShowDebug = function (v) { lsSetString(DBG_SHOW_KEY, v ? 'on' : 'off');   }

  ctx._dbgCopy = function (t) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t);
        else { var _ta = document.createElement('textarea'); _ta.value = t; _ta.style.cssText = 'position:fixed;left:0;top:0;opacity:0'; document.body.appendChild(_ta); _ta.focus(); _ta.select(); document.execCommand('copy'); document.body.removeChild(_ta); }
      } catch (e) {}
      }

  ctx.dbgInfoText = function () {
      var m = detectScreenMode(), vp = getPhysViewport();
      var vvs = (window.visualViewport && window.visualViewport.scale > 0) ? window.visualViewport.scale.toFixed(3) : '∅';
      var fx = _fixedVisual ? 1 : vp.scale, fy = _fixedVisual ? 1 : vp.scaleY;
      var uadM = (navigator.userAgentData && typeof navigator.userAgentData.mobile === 'boolean') ? navigator.userAgentData.mobile : '∅';
      var L = [];
      L.push('URL ' + (location.href || '∅'));
      L.push('📱 ' + (m.small ? t('Small') : t('Large')) + (m.tiny ? '(tiny)' : m.small ? '(smal)' : '') + t(' · baseline ') + m.deviceCssW + 'px');
      L.push('screen ' + m.screenW + '×' + m.screenH + ' dpr ' + m.dpr + ' · outerW ' + (window.outerWidth || '∅'));
      L.push('inner ' + Math.round(innerWidth) + '×' + Math.round(innerHeight) + ' · vv.scale ' + vvs + ' · UA-CH.mobile ' + uadM);
      L.push(t('Visual viewport ') + m.vpW + '×' + m.vpH + ' · ' + (m.mobileUA ? 'mobile' : 'desktop'));
      L.push('vp ' + Math.round(vp.w) + '×' + Math.round(vp.h) + ' s ' + vp.scale.toFixed(3) + (Math.abs(vp.scale - vp.scaleY) > 0.001 ? ' sy ' + vp.scaleY.toFixed(3) : '') + ' · FIXED ' + (_fixedVisual ? 'visual' : 'layout'));
      L.push('platform ' + (navigator.platform || '∅') + '\nUA ' + (navigator.userAgent || '∅').replace(/\s+/g, ' ').slice(0, 140));
      try {
        var fr = ctx.fab.getBoundingClientRect();
        L.push(t('fab on-screen ') + Math.round(fr.left * fx) + '×' + Math.round(fr.top * fy) + ' (' + Math.round(fr.width * fx) + '×' + Math.round(fr.height * fy) + ')' + (ctx.fabInScreen() ? t(' ✓in-viewport') : t(' ✗offscreen')) + ' tr ' + (ctx.fab.style.transform || 'none'));
      } catch (e) {}
      try {
        if (ctx.aiWin) {
          var ar = ctx.aiWin.getBoundingClientRect();
          var iw = (ctx.aiIframe && ctx.aiIframe.contentWindow) ? ctx.aiIframe.contentWindow.innerWidth : 0;
          L.push('AI win display ' + getComputedStyle(ctx.aiWin).display + ' CSS ' + ctx.aiWin.style.width + '×' + ctx.aiWin.style.height + t(' on-screen ') + Math.round(ar.left * fx) + '×' + Math.round(ar.top * fy) + ' (' + Math.round(ar.width * fx) + '×' + Math.round(ar.height * fy) + ') iframe ' + iw);
        }
      } catch (e) {}
      return L.join('\n');
      }

  ctx.placeOverlayCard = function (card) {
      var vp = getPhysViewport(), small = detectScreenMode().small;
      var visW = small ? capVisW(vp, 24) : Math.min(480, capVisW(vp, 40)); // 与 AI 窗同一源
      var _c = visToCss(visW, vp.h - 24, vp.scale, vp.scaleY); // 视觉宽/(屏-24) → CSS（非等比高度补偿）
      card.style.width = _c.w + 'px';
      card.style.maxHeight = _c.h + 'px'; // 配合 flex 列（头/尾固定、中间滚动）→ 底部复制/关闭始终可见
      positionPhysical(card, (vp.w - visW) / 2, 12, vp.scale, vp.scaleY);
      }

  ctx.showDebugPanel = function () {
      if (!ctx.debugPanel) {
        ctx.debugPanel = el('div', { class: 'dbg-overlay' });
        var card = el('div', { class: 'dbg-overlay-card' });
        var head = el('div', { class: 'dbg-dialog-head' });
        head.appendChild(el('span', {}, [t('🔍 Debug info (copy for AI diagnosis)')]));
        var x = el('button', { class: 'dbg-ghost', style: 'border:1px solid #d1d5db;background:#fff;border-radius:6px;padding:2px 8px;cursor:pointer;font:inherit;' }, ['✕']);
        x.addEventListener('click', function () { ctx.debugPanel.classList.remove('dbg-open'); });
        head.appendChild(x);
        card.appendChild(head);
        var body = el('div', { class: 'dbg-dialog-body' });
        var info = el('div', { class: 'dbg-debug-info' });
        var help = el('div', { class: 'dbg-debug-help' });
        help.innerHTML = t('<b>Field notes</b>') +
          t('<code>baseline</code> = screen.width (÷dpr correction for old WebViews reporting physical pixels; tablets with UA-CH mobile=false are not divided); ≥768 large, &lt;480 tiny<br>') +
          t('<code>scale / sy</code> = layout→visual CSS scale (screen.width/innerWidth, screen.height/innerHeight); differ when non-uniform; counter-zoom uses scale<br>') +
          t('<code>FIXED layout/visual</code> = fixed-element coordinate systems: layout needs counter-zoom, visual (iOS) uses visual coords directly<br>') +
          t('<code>on-screen</code> = the element\'s real visual position (rect×scale); ✓in-viewport = visible<br>') +
          t('<code>AI iframe</code> = width as seen by ai.html; should ≈ visual width (mobile layout); too large (900+) = desktop layout shrunk into ants');
        body.appendChild(info); body.appendChild(help);
        card.appendChild(body);
        var foot = el('div', { class: 'dbg-dialog-foot' });
        var lbl = el('label', { style: 'margin-right:auto;display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer;' });
        var cb = el('input', { type: 'checkbox' });
        cb.checked = !ctx.loadShowDebug(); // label="下次不再自动显示"：勾选=关闭（语义取反 loadShowDebug，默认不勾=会自动显示）
        cb.addEventListener('change', function () { ctx.saveShowDebug(!cb.checked); });
        lbl.appendChild(cb); lbl.appendChild(document.createTextNode(t('Do not auto-show next time')));
        var copyBtn = el('button', { class: 'dbg-primary' }, [t('📋 Copy')]);
        copyBtn.addEventListener('click', function () { ctx._dbgCopy(info.textContent); copyBtn.textContent = t('✅ Copied'); setTimeout(function () { copyBtn.textContent = t('📋 Copy'); }, 1200); });
        foot.appendChild(lbl); foot.appendChild(copyBtn);
        card.appendChild(foot);
        ctx.debugPanel.appendChild(card);
        ctx.debugPanel.addEventListener('mousedown', function (ev) { if (ev.target === ctx.debugPanel) ctx.debugPanel.classList.remove('dbg-open'); });
        ctx.root.appendChild(ctx.debugPanel);
        ctx.debugPanel._card = card; ctx.debugPanel._info = info;
      }
      ctx.debugPanel._info.textContent = ctx.dbgInfoText();
      ctx.debugPanel.classList.add('dbg-open');
      ctx.placeOverlayCard(ctx.debugPanel._card);
      }

  ctx.toggleSettings = function (anchorBtn) {
      var existing = ctx.root.querySelector('.dbg-settings');
      if (existing) { existing.remove(); return; }
      var pop = el('div', { class: 'dbg-settings' });
      var lbl = el('label', {}, []);
      var cb = el('input', { type: 'checkbox' });
      cb.checked = ctx.loadShowDebug();
      cb.addEventListener('change', function () { ctx.saveShowDebug(cb.checked); });
      lbl.appendChild(cb); lbl.appendChild(document.createTextNode(t(' auto-show debug info on refresh')));
      pop.appendChild(lbl);
      var viewBtn = el('button', {}, [t('📋 View debug info')]);
      viewBtn.addEventListener('click', function () { pop.remove(); ctx.showDebugPanel(); });
      pop.appendChild(viewBtn);
      ctx.root.appendChild(pop);
      // 定位到 ⚙ 下方（counter-zoom 跟随缩放；下方放不下翻上方）
      var _vp = getPhysViewport(), _r = anchorBtn.getBoundingClientRect();
      var _fx = _fixedVisual ? 1 : _vp.scale, _fy = _fixedVisual ? 1 : _vp.scaleY;
      var _vL = Math.max(4, _r.left * _fx), _vT = _r.bottom * _fy + 4;
      positionPhysical(pop, _vL, _vT, _vp.scale, _vp.scaleY);
      requestAnimationFrame(function () {
        try {
          var _w2 = pop.offsetWidth * _fx, _h2 = pop.offsetHeight * _fy;
          var cL = Math.min(_vL, Math.max(4, _vp.w - _w2 - 4));
          var cT = (_vT + _h2 > _vp.h - 4) ? Math.max(4, _r.top * _fy - _h2 - 4) : _vT;
          if (cL !== _vL || cT !== _vT) positionPhysical(pop, cL, cT, _vp.scale, _vp.scaleY);
        } catch (e) {}
      });
      setTimeout(function () {
        var close = function (ev) {
          if (!pop.parentNode) { document.removeEventListener('mousedown', close); return; }
          if (!pop.contains(ev.target) && !anchorBtn.contains(ev.target)) { pop.remove(); document.removeEventListener('mousedown', close); }
        };
        document.addEventListener('mousedown', close);
      }, 0);
      }
}
