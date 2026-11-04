// dialog 子系统（ctx 模式：initX(ctx) 注册本子系统函数，Phase A 调用）
import { el, escapeHtml } from './dom.js';
import { isSmallScreen, getPhysViewport, capVisW, _fixedVisual, placePhysPanel } from './viewport.js';

export function initDialog(ctx) {
  // 属性值转义：escapeHtml 只转 &<>，属性（data-copy/data-file/title）需额外转引号——防 HTML 注入
  function escAttr(s) { return escapeHtml(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  // 复制文本：Clipboard API → execCommand 兜底 → 转发宿主（dbg_copy 协议，iframe 无权限时）
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
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        done(ok);
      } catch (e) { done(false); }
    }
  }
  ctx.renderPreview = function (p) {
      ctx.preview.innerHTML = '';
      // 行结构 [label, html, plain]——plain 供「📋 复制」用（纯文本）
      var rows = [];
      var addRow = function (label, html, plain) { rows.push([label, html, plain || '']); };
      var _tagPlain = p.tag + (p.rect ? ' ' + p.rect.w + '×' + p.rect.h : '');
      addRow('标签', '<b>' + p.tag + '</b> ' + (p.rect ? p.rect.w + '×' + p.rect.h : ''), _tagPlain);
      // 兼容两种 payload：富载荷（framework 嵌套）与 hover 轻载荷（component/file/usedAt 顶层）
      // ——hover 浮窗（HUD）用顶层字段直接显示，但预览弹窗此前只读 framework 嵌套，轻载荷进来组件/调用于不显示
      var fl = p.framework || {};
      var _fw = fl.framework || null;
      var _comp = fl.component || p.component || null;
      var _file = fl.file || p.file || null;
      var _line = fl.line || p.line || null;
      var _ua = fl.usedAt || p.usedAt || null;
      if (_fw || _comp || _file || (_ua && (_ua.file || _ua.component))) {
        var _flTxt = (_fw || '') + (_comp ? ((_fw ? ' · ' : '') + _comp) : '');
        // 文件行：文件名（:行号）+ 打开按钮（📂 后台经桥 open_file → AITI_OPEN_CMD/系统默认；🖥 前端经 AI 窗 → pi-web 文件标签页）
        var _miniBtn = function (act, fp, ln) {
          return ' <button class="dbg-mini-open" style="border:1px solid #c7d2fe;border-radius:5px;padding:0 6px;font-size:10px;cursor:pointer;background:#eef2ff;color:#4338ca;vertical-align:middle" data-act="' + act + '" data-file="' + escAttr(fp) + '" data-line="' + (ln || '') + '">' + (act === 'frontend' ? '🖥 前端' : '📂 后台') + '</button>';
        };
        if (_file) {
          _flTxt += '<br>📄 组件源码 <span title="' + escAttr(_file) + '">' + escapeHtml(String(_file).split('/').pop()) + (_line ? ':' + _line : '') + '</span>'
            + _miniBtn('backend', _file, _line) + _miniBtn('frontend', _file, _line);
        }
        if (_ua && (_ua.file || _ua.component)) {
          if (_ua.file) {
            _flTxt += '<br>📍 调用于 <span title="' + escAttr(_ua.file) + '">' + escapeHtml(String(_ua.file).split('/').pop()) + (_ua.line ? ':' + _ua.line : '') + '</span>'
              + _miniBtn('backend', _ua.file, _ua.line) + _miniBtn('frontend', _ua.file, _ua.line);
          } else if (_ua.component) {
            // 构建未注入源码路径（__file 缺失）：仍显示调用组件名
            _flTxt += '<br>📍 调用于 ' + escapeHtml(_ua.component);
          }
        }
        // 框架行纯文本（复制用）：组件 + 源码路径:行 + 调用于
        var _flPlain = ((_fw || '') + (_comp ? ((_fw ? ' ' : '') + _comp) : '')).trim();
        if (_file) _flPlain += '\n组件源码: ' + _file + (_line ? ':' + _line : '');
        if (_ua && _ua.file) _flPlain += '\n调用于: ' + _ua.file + (_ua.line ? ':' + _ua.line : '');
        else if (_ua && _ua.component) _flPlain += '\n调用于: ' + _ua.component;
        addRow('框架', '<span class="dbg-pv-file">' + _flTxt + '</span>', _flPlain);
      }
      if (p.text) addRow('文本', escapeHtml(p.text.trim().slice(0, 80)), String(p.text).trim().slice(0, 200));
      // path + css selector
      if (p.xpath) addRow('path', '<span class="dbg-pv-kv">' + p.xpath + '</span>', p.xpath);
      if (p.selector) addRow('css selector', '<span class="dbg-pv-kv">' + p.selector + '</span>', p.selector);
      // 属性（class/id/aria/data——收取了但之前没显示，用户实测预览信息不全）
      if (p.attributes) {
        var _attrBits = [];
        var _attrPlain = [];
        var _cls2 = String(p.attributes.class || '').trim().split(/\s+/).filter(Boolean).slice(0, 6);
        if (p.attributes.id) { _attrBits.push('#' + String(p.attributes.id)); _attrPlain.push('#' + String(p.attributes.id)); }
        if (_cls2.length) { _attrBits.push('.' + _cls2.join('.')); _attrPlain.push('.' + _cls2.join('.')); }
        Object.keys(p.attributes).forEach(function (k) {
          if (/^aria-|^data-/.test(k)) { _attrBits.push(escapeHtml(k + '=' + String(p.attributes[k]).slice(0, 60))); _attrPlain.push(k + '=' + String(p.attributes[k]).slice(0, 60)); }
        });
        if (_attrBits.length) addRow('属性', '<span class="dbg-pv-kv">' + _attrBits.slice(0, 10).join(' ') + '</span>', _attrPlain.slice(0, 10).join(' '));
      }
      // 样式：颜色值渲染为实际颜色（swatch + 彩色文本——样式生效）；字段补全（position/border/opacity/overflow 等）
      if (p.computed) {
        var bits = [];
        ['display', 'position', 'width', 'height', 'flexDirection', 'gap', 'padding', 'margin', 'border', 'borderRadius', 'fontSize', 'fontWeight', 'color', 'backgroundColor', 'opacity', 'boxShadow', 'zIndex', 'overflow']
          .forEach(function (k) {
            if (p.computed[k]) bits.push(k + ':' + p.computed[k]);
          });
        // 换行显示全（不再 slice(0,10) 截断——用户实测样式 css 没显示全）
        addRow('样式', bits.map(function (b) {
          var m = b.match(/^(color|backgroundColor):(.*)$/);
          if (m) {
            return '<span class="dbg-pv-kv" style="color:' + m[2] + '"><span style="display:inline-block;width:10px;height:10px;background:' + m[2] + ';border-radius:2px;vertical-align:middle;margin-right:3px;border:1px solid rgba(255,255,255,.3)"></span>' + m[2] + '</span>';
          }
          return '<span class="dbg-pv-kv">' + b + '</span>';
        }).join('<br>'), bits.join('; '));
      }
      // 不在 computed 时的显式颜色/字体
      if (p.color && !(p.computed && p.computed.color)) addRow('前景色', escapeHtml(p.color), p.color);
      if (p.bg && !(p.computed && p.computed.backgroundColor) && p.bg !== 'rgba(0, 0, 0, 0)') addRow('背景色', escapeHtml(p.bg), p.bg);
      if (p.fontSize && !(p.computed && p.computed.fontSize)) addRow('字号', escapeHtml(p.fontSize), p.fontSize);
      // 页面地址 / pageId（收取了但之前没显示）
      if (p.frame && p.frame.url) addRow('页面', escapeHtml(String(p.frame.url).slice(0, 200)), String(p.frame.url));
      if (p.pageId) addRow('pageId', escapeHtml(String(p.pageId)), String(p.pageId));
      rows.forEach(function (r) {
        var row = el('div', { class: 'dbg-pv-row' });
        // 📋 复制：hover 显示（CSS），data-copy 存纯文本——iframe 内 Clipboard 失败时转发宿主（dbg_copy 协议）
        row.innerHTML = '<b>' + r[0] + '</b> ' + r[1]
          + ' <button class="dbg-pv-copy" data-copy="' + escAttr(r[2] || '') + '" title="复制此内容">📋</button>';
        ctx.preview.appendChild(row);
      });
      }

  // 打开预览弹窗：小屏时贴底全宽 + counter-zoom（视觉尺寸 = CSS 尺寸，字体可读）+ 盖住工具条（参照 AI 窗）
  ctx.showDialog = function () {
      // dialog 内源文件点击 → 后台打开（委托一次，dialog 创建后）
      if (!ctx.dialog.__openFileBound) {
        ctx.dialog.__openFileBound = true;
        ctx.dialog.addEventListener('click', function (ev) {
          var a = ev.target && ev.target.closest ? ev.target.closest('.dbg-open-file') : null;
          if (a) { ev.stopPropagation(); ctx.openFileAt(a.getAttribute('data-file'), parseInt(a.getAttribute('data-line'), 10) || null); return; }
          // 📋 行复制：Clipboard API 优先；iframe 无权限失败 → 转发宿主（dbg_copy 协议 → AI 窗 pi-web 页复制）
          var cc = ev.target && ev.target.closest ? ev.target.closest('.dbg-pv-copy') : null;
          if (cc) {
            ev.stopPropagation();
            var ctxt = cc.getAttribute('data-copy') || '';
            copyToClipboard(ctxt, function (ok) {
              if (ok) {
                try { ctx.addMsg('sys', '📋 已复制：' + ctxt.slice(0, 40)); if (ctx.showPickToast) ctx.showPickToast('<b>📋 已复制</b>'); } catch (e) {}
              }
              else {
                try { ctx.postToAi({ type: 'dbg_copy', payload: { text: ctxt } }); ctx.addMsg('sys', '📋 已转发宿主复制'); if (ctx.showPickToast) ctx.showPickToast('<b>📋 已转发宿主复制</b>'); } catch (e) {}
              }
            });
            return;
          }
          var b = ev.target && ev.target.closest ? ev.target.closest('.dbg-mini-open') : null;
          if (b) {
            ev.stopPropagation();
            var fp2 = b.getAttribute('data-file');
            var ln2 = parseInt(b.getAttribute('data-line'), 10) || null;
            // 转发前确保 AI 窗存在并打开显示（预览窗在 host，AI 窗可能隐藏/未创建——用户可见反馈 + 消息可达）
            try {
              ctx.ensureAi(); ctx.showAi(true); ctx.aiOpen = true;
              if (ctx.aiBtn) ctx.aiBtn.classList.add('dbg-on');
            } catch (e) {}
            if (b.getAttribute('data-act') === 'frontend') {
              // 前端打开（pi-web 文件标签页）：AI 窗在 pi-web 页面内，转发 dbg_ai_open_file → aiti_open_file（openFileFrontend 自做存在性校验）
              try { ctx.postToAi({ type: 'dbg_ai_open_file', payload: { file: fp2, line: ln2 } }); ctx.addMsg('sys', '🖥 已请求前端打开（pi-web 文件标签页）：' + fp2 + (ln2 ? ':' + ln2 : '')); if (!ctx.aiReady) ctx.addMsg('sys', '⏳ AI 窗加载中——就绪后自动执行（如长时间无反应，检查 AI 窗是否正常打开）'); } catch (e) {}
            } else {
              ctx.openFileAt(fp2, ln2);
              try { if (!ctx.aiReady) ctx.addMsg('sys', '⏳ AI 窗加载中——就绪后自动执行（如长时间无反应，检查 AI 窗是否正常打开）'); } catch (e) {}
            }
          }
        });
      }
      ctx.dialog.classList.add('dbg-open');
      if (isSmallScreen()) {
        ctx.dialog.style.zIndex = '2147483648'; // 盖住工具条（2147483647）
        var card = ctx.dialog.querySelector('.dbg-dialog-card');
        if (card) {
          // 公共浮层定位（与 AI 窗/HUD 同套算法 placePhysPanel）：视觉全宽 + 自适应内容高（上限 92% 可视高）+ 贴底
          //   高度自适应 = 卡片高度 = 实际内容高（固定 92% 会在内容不满时出现底部大片空白——用户实测）；
          //   贴底基准 = 可视视觉高（innerHeight×scaleY——纵向 scale！横向 scale 会算小导致悬空/按钮被切）
          var vp = getPhysViewport();
          var visW = capVisW(vp, 0); // 视觉全宽
          var visVh = _fixedVisual ? ((window.visualViewport && window.visualViewport.height) || window.innerHeight)
                                   : (window.innerHeight * vp.scaleY);
          card.style.position = 'fixed'; // 脱离 flex（positionPhysical 依赖 fixed）
          card.style.maxHeight = '';     // 清残留——高度由内容撑开（placePhysPanel 限宽后测 scrollHeight）
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

  // 预览关闭（✕/取消）：只关预览弹窗，恢复工具条（inspect 仍激活时）——预览为可选（工具条标题文字点击打开）
  ctx.closePreview = function () {
      ctx.dialog.classList.remove('dbg-open');
      // 恢复工具条（预览打开时关掉了它；inspect 仍激活才恢复）
      try {
        if ((ctx.inspectorOn || ctx.aiInspectActive) && ctx.root) {
          var _tbEl = ctx.root.querySelector('.dbg-toolbar');
          if (_tbEl) _tbEl.classList.add('dbg-on');
        }
      } catch (e) {}
      }
}
