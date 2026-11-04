// help 子系统（ctx 模式：initX(ctx) 注册本子系统函数，Phase A 调用）
// 选区工具条 ❓ 使用帮助窗：按钮一览 / 快捷键总表 / 进阶技巧（放行工作流）/ 触屏导航可点入口。
// 打开时工具条保持显示（对照选区读帮助——与预览弹窗「打开即关工具条」刻意相反）。
// 定位 placePhysPanel 底部居中 + 头部 makePointerDrag 拖动（pick dialog 同款模式）；
// 不用 data-ext-float（那是 pi-web 客户端扩展契约，launcher 跑在任意目标页无接管方）。
import { el } from './dom.js';
import { getPhysViewport, placePhysPanel } from './viewport.js';
import { makePointerDrag } from './drag.js';

export function initHelp(ctx) {

  ctx.helpDialogOpen = function () {
      return !!(ctx.helpDialog && ctx.helpDialog.parentNode);
      }

  ctx.closeHelpDialog = function () {
      if (ctx.helpDialog && ctx.helpDialog.parentNode) ctx.helpDialog.parentNode.removeChild(ctx.helpDialog);
      ctx.helpDialog = null;
      }

  ctx.toggleHelpDialog = function () {
      if (ctx.helpDialogOpen()) { ctx.closeHelpDialog(); return; }
      var d = el('div', { class: 'dbg-help-dialog' });
      var head = el('div', { class: 'dbg-help-head' });
      head.appendChild(el('span', {}, ['❓ 选区工具条 · 使用帮助']));
      var hClose = el('button', { title: '关闭（Esc）' }, ['✕']);
      hClose.addEventListener('click', function (ev) { ev.stopPropagation(); ctx.closeHelpDialog(); });
      head.appendChild(hClose);
      d.appendChild(head);

      var body = el('div', { class: 'dbg-help-body' });
      // 静态文案用 innerHTML（全部只读内容，无用户输入拼接）
      body.innerHTML = [
        '<h4>这是什么</h4>',
        '<div>划过页面元素高亮预览，点击锁定后出现这个工具条——用方向键微调选区，<b>✓ 确认发送给 AI</b>。<br>',
        '💡 点顶部标签行文字（<code>&lt;div&gt; 320×48 …</code>）可打开详情预览弹窗。</div>',
        '<h4>① 按钮一览</h4>',
        '<table>',
        '<tr><td><b>↖ 父级 / ↘ 子级</b></td><td>沿 DOM 树上/下一层（斜向=走树）；子级没有时自动同级下一个</td></tr>',
        '<tr><td><b>← ↑ ↓ →</b></td><td>页面<b>几何位置</b>相邻元素（与键盘方向键同位）</td></tr>',
        '<tr><td><b>#</b></td><td>快速选择：输入 CSS selector 或 XPath 定位</td></tr>',
        '<tr><td><b>🖱 恢复快选</b></td><td>回到「划过即选」（锁定后 hover 快选暂停防误切）</td></tr>',
        '<tr><td><b>👆 模拟hover</b></td><td>给选中元素派发真实 mouseenter，JS 悬停展开持久保持；再点清除</td></tr>',
        '<tr><td><b>🔒 放行方案</b></td><td>锁定后页面事件默认冻结；下拉切换方案，末尾「⚙️ 自定义…」打开设置面板管理多个自定义方案</td></tr>',
        '<tr><td><b>✕ / ✓</b></td><td>取消退出 / 确认发送</td></tr>',
        '</table>',
        '<h4>② 快捷键总表</h4>',
        '<table>',
        '<tr><td><kbd>←</kbd> <kbd>→</kbd> <kbd>↑</kbd> <kbd>↓</kbd></td><td>页面几何相邻元素</td></tr>',
        '<tr><td><kbd>Enter</kbd></td><td>子级（无子级→同级 next，一路按遍历整棵 DOM 树）</td></tr>',
        '<tr><td><kbd>Backspace</kbd> / <kbd>Delete</kbd></td><td>父级</td></tr>',
        '<tr><td><kbd>PageUp</kbd> / <kbd>PageDown</kbd></td><td>DOM 平级前一个 / 后一个（按钮已收起，仅快捷键）</td></tr>',
        '<tr><td><kbd>Home</kbd> / <kbd>End</kbd></td><td>子级首个 / 末个（同上）</td></tr>',
        '<tr><td><kbd>空格</kbd> / <kbd>Tab</kbd></td><td>放行方案一键切换：默认放行 ⇄ 全部放行（两键同效，防系统监控占据空格）</td></tr>',
        '<tr><td><kbd>Esc</kbd></td><td>关帮助窗 → 取消/退出</td></tr>',
        '</table>',
        '<div class="dbg-help-note">快捷键在工具条显示时生效；光标在输入框时不劫持。</div>',
        '<h4>③ 进阶：点不动页面按钮？「放行 → 触发 → 切回 → 选中」</h4>',
        '<ol>',
        '<li>按 <kbd>空格</kbd> 或 <kbd>Tab</kbd> → 切到 🔓 <b>全部放行</b></li>',
        '<li>点击目标按钮 → 真实事件触发，菜单展开</li>',
        '<li>再按 <kbd>空格</kbd>/<kbd>Tab</kbd> → 切回 🔒 <b>默认放行</b>（展开的菜单不会收起）</li>',
        '<li>划过/方向键选中菜单项，<b>✓</b> 发送</li>',
        '</ol>',
        '<div>其他：<b>👆 模拟 hover</b> 对付 JS 悬停展开（CSS :hover 除外）；<b># 快速选择</b>支持 <code>.card button</code> 与 <code>//div[@class="card"]</code>。</div>',
        '<h4>④ 键盘没有时（触屏）：以下方向点按钮直达</h4>',
        '<div class="dbg-help-nav-row">',
        '<button data-dir="prev">◀ 前一个</button>',
        '<button data-dir="next">▶ 后一个</button>',
        '<button data-dir="first">⏮ 最前</button>',
        '<button data-dir="last">⏭ 最后</button>',
        '</div>',
        '<div class="dbg-help-note">对应快捷键 PageUp/PageDown/Home/End。</div>',
      ].join('');
      // 触屏导航兜底：◀▶⏮⏭ 可点入口（按钮已从工具条撤下，触屏无 PageUp/PageDown/Home/End）
      body.querySelectorAll('.dbg-help-nav-row button').forEach(function (b) {
        b.addEventListener('click', function () { ctx.doNav(b.getAttribute('data-dir')); });
      });
      d.appendChild(body);

      d.style.zIndex = '2147483648'; // 盖工具条（2147483647）
      // 头部拖动（pick dialog 同款模式）：按住头部移动面板，头部内按钮交互不拖
      try {
        makePointerDrag({
          handle: head, capture: 'now', raf: true, preventStart: true,
          filter: function (e) { return !(e.target && e.target.tagName === 'BUTTON'); },
          onStart: function () {
            d.classList.add('dbg-dragging');
            return { left: d.offsetLeft || 0, top: d.offsetTop || 0 };
          },
          onMove: function (ev, st, dx, dy) {
            var nl = Math.min(Math.max(0, st.left + dx), Math.max(0, (window.innerWidth || 0) - 40));
            var nt = Math.min(Math.max(0, st.top + dy), Math.max(24, (window.innerHeight || 0) - 40));
            d.style.left = nl + 'px';
            d.style.top = nt + 'px';
            d.style.right = 'auto';
            d.style.bottom = 'auto';
          },
          onEnd: function () { d.classList.remove('dbg-dragging'); },
        });
      } catch (e) {}
      ctx.root.appendChild(d);
      // 公共浮层定位：底部居中、限宽、自适应内容高、≤可视区（visualViewport 跟踪自动注册）
      placePhysPanel(d, { visW: Math.min(480, Math.round(getPhysViewport().w) - 24), dock: 'bottom', gap: 12, maxWidth: '480px', overflowY: 'auto' });
      ctx.helpDialog = d;
      }
}
