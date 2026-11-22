// dialog subsystem (ctx pattern: initX(ctx) registers this subsystem's functions, invoked in Phase A)
import { el, escapeHtml } from './dom.js';
import { isSmallScreen, getPhysViewport, capVisW, _fixedVisual, placePhysPanel } from './viewport.js';
import { t } from './i18n.js';

export function initDialog(ctx) {
  // Attribute value escaping: escapeHtml only handles &<>, attributes (data-copy/data-file/title) additionally need quote escaping -- prevents HTML injection
  function escAttr(s) { return escapeHtml(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  // Copy text: Clipboard API -> execCommand fallback -> forward to host (dbg_copy protocol, for iframes
  // without permission). Focus resilience: both paths require a focused document -- writeText rejects
  // with NotAllowedError when blurred, execCommand fails the same way; the fallback therefore calls
  // window.focus() + textarea.focus() first (a click blocked by the UI guards' preventDefault never
  // focuses the document, so focus must be pulled explicitly).
  function copyToClipboard(text, cb) {
    var done = function (ok) { if (cb) cb(!!ok); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { done(true); }, function () { fallback(); });
        return;
      }
    } catch (e) {}
    fallback();
    function fallback() {
      try { if (!document.hasFocus()) window.focus(); } catch (e) {}
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        done(ok);
      } catch (e) { done(false); }
    }
  }
  ctx.copyToClipboard = copyToClipboard; // shared: ask/notify panels reuse (interact.js)
  ctx.renderPreview = function (p) {
      ctx.preview.innerHTML = '';
      // Row structure [label, html, plain] -- plain feeds the "📋 Copy" button (plain text)
      var rows = [];
      var addRow = function (label, html, plain) { rows.push([label, html, plain || '']); };
      var _tagPlain = p.tag + (p.rect ? ' ' + p.rect.w + '×' + p.rect.h : '');
      addRow(t('Tag'), '<b>' + p.tag + '</b> ' + (p.rect ? p.rect.w + '×' + p.rect.h : ''), _tagPlain);
      // Support two payload shapes: rich payload (framework nesting) and light hover payload (component/file/usedAt at top level)
      // -- the hover floating window (HUD) shows top-level fields directly, but the preview dialog previously only read the framework nesting, so components/call sites did not show for light payloads
      var fl = p.framework || {};
      var _fw = fl.framework || null;
      var _comp = fl.component || p.component || null;
      var _file = fl.file || p.file || null;
      var _line = fl.line || p.line || null;
      var _ua = fl.usedAt || p.usedAt || null;
      if (_fw || _comp || _file || (_ua && (_ua.file || _ua.component))) {
        var _flTxt = (_fw || '') + (_comp ? ((_fw ? ' · ' : '') + _comp) : '');
        // File row: file name (:line) + open buttons (📂 backend goes through the bridge open_file → AITI_OPEN_CMD/system default; 🖥 frontend goes through the AI window → pi-web file tab)
        var _miniBtn = function (act, fp, ln) {
          return ' <button class="dbg-mini-open" style="border:1px solid #c7d2fe;border-radius:5px;padding:0 6px;font-size:10px;cursor:pointer;background:#eef2ff;color:#4338ca;vertical-align:middle" data-act="' + act + '" data-file="' + escAttr(fp) + '" data-line="' + (ln || '') + '">' + (act === 'frontend' ? t('🖥 Frontend') : t('📂 Backend')) + '</button>';
        };
        if (_file) {
          _flTxt += t('<br>📄 Component source <span title="') + escAttr(_file) + '">' + escapeHtml(String(_file).split('/').pop()) + (_line ? ':' + _line : '') + '</span>'
            + _miniBtn('backend', _file, _line) + _miniBtn('frontend', _file, _line);
        }
        if (_ua && (_ua.file || _ua.component)) {
          if (_ua.file) {
            _flTxt += t('<br>📍 Called at <span title="') + escAttr(_ua.file) + '">' + escapeHtml(String(_ua.file).split('/').pop()) + (_ua.line ? ':' + _ua.line : '') + '</span>'
              + _miniBtn('backend', _ua.file, _ua.line) + _miniBtn('frontend', _ua.file, _ua.line);
          } else if (_ua.component) {
            // Build did not inject the source path (__file missing): still show the calling component name
            _flTxt += t('<br>📍 Called at ') + escapeHtml(_ua.component);
          }
        }
        // Framework row plain text (for copy): component + source path:line + called at
        var _flPlain = ((_fw || '') + (_comp ? ((_fw ? ' ' : '') + _comp) : '')).trim();
        if (_file) _flPlain += t('\nComponent source: ') + _file + (_line ? ':' + _line : '');
        if (_ua && _ua.file) _flPlain += t('\nCalled at: ') + _ua.file + (_ua.line ? ':' + _ua.line : '');
        else if (_ua && _ua.component) _flPlain += t('\nCalled at: ') + _ua.component;
        addRow(t('Framework'), '<span class="dbg-pv-file">' + _flTxt + '</span>', _flPlain);
      }
      if (p.text) addRow(t('Text'), escapeHtml(p.text.trim().slice(0, 80)), String(p.text).trim().slice(0, 200));
      // path + css selector
      if (p.xpath) addRow('path', '<span class="dbg-pv-kv">' + p.xpath + '</span>', p.xpath);
      if (p.selector) addRow('css selector', '<span class="dbg-pv-kv">' + p.selector + '</span>', p.selector);
      // Attributes (class/id/aria/data -- collected but previously not shown; user-observed incomplete preview info)
      if (p.attributes) {
        var _attrBits = [];
        var _attrPlain = [];
        var _cls2 = String(p.attributes.class || '').trim().split(/\s+/).filter(Boolean).slice(0, 6);
        if (p.attributes.id) { _attrBits.push('#' + String(p.attributes.id)); _attrPlain.push('#' + String(p.attributes.id)); }
        if (_cls2.length) { _attrBits.push('.' + _cls2.join('.')); _attrPlain.push('.' + _cls2.join('.')); }
        Object.keys(p.attributes).forEach(function (k) {
          if (/^aria-|^data-/.test(k)) { _attrBits.push(escapeHtml(k + '=' + String(p.attributes[k]).slice(0, 60))); _attrPlain.push(k + '=' + String(p.attributes[k]).slice(0, 60)); }
        });
        if (_attrBits.length) addRow(t('Attributes'), '<span class="dbg-pv-kv">' + _attrBits.slice(0, 10).join(' ') + '</span>', _attrPlain.slice(0, 10).join(' '));
      }
      // Styles: color values rendered as actual colors (swatch + colored text -- styles take effect); field coverage (position/border/opacity/overflow, etc.)
      if (p.computed) {
        var bits = [];
        ['display', 'position', 'width', 'height', 'flexDirection', 'gap', 'padding', 'margin', 'border', 'borderRadius', 'fontSize', 'fontWeight', 'color', 'backgroundColor', 'opacity', 'boxShadow', 'zIndex', 'overflow']
          .forEach(function (k) {
            if (p.computed[k]) bits.push(k + ':' + p.computed[k]);
          });
        // Show everything on separate lines (no more slice(0,10) truncation -- user-observed truncated style css)
        addRow(t('Styles'), bits.map(function (b) {
          var m = b.match(/^(color|backgroundColor):(.*)$/);
          if (m) {
            return '<span class="dbg-pv-kv" style="color:' + m[2] + '"><span style="display:inline-block;width:10px;height:10px;background:' + m[2] + ';border-radius:2px;vertical-align:middle;margin-right:3px;border:1px solid rgba(255,255,255,.3)"></span>' + m[2] + '</span>';
          }
          return '<span class="dbg-pv-kv">' + b + '</span>';
        }).join('<br>'), bits.join('; '));
      }
      // Explicit colors/fonts when not present in computed
      if (p.color && !(p.computed && p.computed.color)) addRow(t('Foreground'), escapeHtml(p.color), p.color);
      if (p.bg && !(p.computed && p.computed.backgroundColor) && p.bg !== 'rgba(0, 0, 0, 0)') addRow(t('Background'), escapeHtml(p.bg), p.bg);
      if (p.fontSize && !(p.computed && p.computed.fontSize)) addRow(t('Font size'), escapeHtml(p.fontSize), p.fontSize);
      // Page URL / pageId (collected but previously not shown)
      if (p.frame && p.frame.url) addRow(t('Page'), escapeHtml(String(p.frame.url).slice(0, 200)), String(p.frame.url));
      if (p.pageId) addRow('pageId', escapeHtml(String(p.pageId)), String(p.pageId));
      rows.forEach(function (r) {
        var row = el('div', { class: 'dbg-pv-row' });
        // 📋 Copy: shown on hover (CSS), data-copy holds plain text -- when Clipboard fails inside an iframe, forwards to the host (dbg_copy protocol)
        row.innerHTML = '<b>' + r[0] + '</b> ' + r[1]
          + ' <button class="dbg-pv-copy" data-copy="' + escAttr(r[2] || '') + t('" title="Copy this content">📋</button>');
        ctx.preview.appendChild(row);
      });
      }

  // Open the preview dialog: on small screens dock bottom full width + counter-zoom (visual size = CSS size, readable fonts) + cover the toolbar (per the AI window)
  ctx.showDialog = function () {
      // Source-file clicks inside the dialog → open in backend (delegated once, after dialog creation)
      if (!ctx.dialog.__openFileBound) {
        ctx.dialog.__openFileBound = true;
        ctx.dialog.addEventListener('click', function (ev) {
          var a = ev.target && ev.target.closest ? ev.target.closest('.dbg-open-file') : null;
          if (a) { ev.stopPropagation(); ctx.openFileAt(a.getAttribute('data-file'), parseInt(a.getAttribute('data-line'), 10) || null); return; }
          // 📋 Row copy: Clipboard API first; permission-denied failure in iframes → forward to host (dbg_copy protocol → copy on the AI window pi-web page)
          var cc = ev.target && ev.target.closest ? ev.target.closest('.dbg-pv-copy') : null;
          if (cc) {
            ev.stopPropagation();
            var ctxt = cc.getAttribute('data-copy') || '';
            copyToClipboard(ctxt, function (ok) {
              if (ok) {
                try { ctx.addMsg('sys', t('📋 Copied: ') + ctxt.slice(0, 40)); if (ctx.showPickToast) ctx.showPickToast(t('<b>📋 Copied</b>')); } catch (e) {}
              }
              else {
                try { ctx.postToAi({ type: 'dbg_copy', payload: { text: ctxt } }); ctx.addMsg('sys', t('📋 Forwarded to host for copy')); if (ctx.showPickToast) ctx.showPickToast(t('<b>📋 Forwarded to host for copy</b>')); } catch (e) {}
              }
            });
            return;
          }
          var b = ev.target && ev.target.closest ? ev.target.closest('.dbg-mini-open') : null;
          if (b) {
            ev.stopPropagation();
            var fp2 = b.getAttribute('data-file');
            var ln2 = parseInt(b.getAttribute('data-line'), 10) || null;
            // Before forwarding, make sure the AI window exists and is shown (the preview window is in the host; the AI window may be hidden/not created -- visible user feedback + message reaches it)
            try {
              ctx.ensureAi(); ctx.showAi(true); ctx.aiOpen = true;
              if (ctx.aiBtn) ctx.aiBtn.classList.add('dbg-on');
            } catch (e) {}
            if (b.getAttribute('data-act') === 'frontend') {
              // Frontend open (pi-web file tab): the AI window lives inside the pi-web page, forward dbg_ai_open_file → aiti_open_file (openFileFrontend does its own existence check)
              try { ctx.postToAi({ type: 'dbg_ai_open_file', payload: { file: fp2, line: ln2 } }); ctx.addMsg('sys', t('🖥 Requested frontend open (pi-web file tab): ') + fp2 + (ln2 ? ':' + ln2 : '')); if (!ctx.aiReady) ctx.addMsg('sys', t('⏳ AI window loading — runs when ready (no response for long? check the AI window opened properly)')); } catch (e) {}
            } else {
              ctx.openFileAt(fp2, ln2);
              try { if (!ctx.aiReady) ctx.addMsg('sys', t('⏳ AI window loading — runs when ready (no response for long? check the AI window opened properly)')); } catch (e) {}
            }
          }
        });
      }
      ctx.dialog.classList.add('dbg-open');
      if (isSmallScreen()) {
        ctx.dialog.style.zIndex = '2147483648'; // cover the toolbar (2147483647)
        var card = ctx.dialog.querySelector('.dbg-dialog-card');
        if (card) {
          // Shared floating-layer positioning (same placePhysPanel algorithm as the AI window/HUD): visual full width + content-adaptive height (capped at 92% of visual height) + docked bottom
          //   adaptive height = card height = actual content height (a fixed 92% leaves a large blank area at the bottom when content is short -- user-observed);
          //   dock-bottom baseline = visual viewport height (innerHeight×scaleY -- vertical scale! the horizontal scale would underestimate it, causing floating gaps/clipped buttons)
          var vp = getPhysViewport();
          var visW = capVisW(vp, 0); // visual full width
          var visVh = _fixedVisual ? ((window.visualViewport && window.visualViewport.height) || window.innerHeight)
                                   : (window.innerHeight * vp.scaleY);
          card.style.position = 'fixed'; // taken out of the flex flow (positionPhysical relies on fixed)
          card.style.maxHeight = '';     // clear residue -- height grows from content (placePhysPanel measures scrollHeight after capping width)
          placePhysPanel(card, { visW: visW, dock: 'bottom', gap: 0, visX: 0, borderRadius: '14px 14px 0 0', minH: 0, maxH: Math.round(visVh * 0.92) });
        }
      } else {
        ctx.dialog.style.alignItems = ''; ctx.dialog.style.zIndex = '';
        var card2 = ctx.dialog.querySelector('.dbg-dialog-card');
        if (card2) { card2.style.position = ''; card2.style.width = ''; card2.style.maxWidth = ''; card2.style.maxHeight = ''; card2.style.borderRadius = ''; card2.style.transform = ''; card2.style.left = ''; card2.style.top = ''; }
      }
      }

  ctx.closeDialog = function () {
      ctx.dialog.classList.remove('dbg-open');
      ctx.exitInspector();
      ctx.exitSelfClient();
      }

  // Preview close (✕/cancel): close only the preview dialog and restore the toolbar (when inspect is still active) -- the preview is optional (opened by clicking the toolbar title text)
  ctx.closePreview = function () {
      ctx.dialog.classList.remove('dbg-open');
      // Restore the toolbar (it was hidden when the preview opened; restored only if inspect is still active)
      try {
        if ((ctx.inspectorOn || ctx.aiInspectActive) && ctx.root) {
          var _tbEl = ctx.root.querySelector('.dbg-toolbar');
          if (_tbEl) _tbEl.classList.add('dbg-on');
        }
      } catch (e) {}
      }
}
