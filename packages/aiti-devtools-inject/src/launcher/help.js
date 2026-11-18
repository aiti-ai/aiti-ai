// help subsystem (ctx pattern: initX(ctx) registers this subsystem's functions, invoked in Phase A)
// Selection toolbar ❓ help dialog: button overview / shortcut table / advanced tricks (allow workflow) / tappable touch navigation entries.
// The toolbar stays visible while open (read help alongside the selection — deliberately the opposite of the preview dialog's "toolbar closes on open").
// Positioned via placePhysPanel bottom-center + header dragged with makePointerDrag (same pattern as the pick dialog);
// no data-ext-float (that's the pi-web client extension contract; the launcher runs on arbitrary target pages with no takeover party).
import { el } from './dom.js';
import { getPhysViewport, placePhysPanel } from './viewport.js';
import { makePointerDrag } from './drag.js';
import { t } from './i18n.js';

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
      head.appendChild(el('span', {}, [t('❓ Selection toolbar · Help')]));
      var hClose = el('button', { title: t('Close (Esc)') }, ['✕']);
      hClose.addEventListener('click', function (ev) { ev.stopPropagation(); ctx.closeHelpDialog(); });
      head.appendChild(hClose);
      d.appendChild(head);

      var body = el('div', { class: 'dbg-help-body' });
      // Static copy is rendered with innerHTML (all read-only content, no user-input concatenation)
      body.innerHTML = [
        t('<h4>What is this</h4>'),
        t('<div>Hover page elements to preview, click to lock and this toolbar appears — fine-tune with arrow keys, <b>✓ to send to AI</b>.<br>'),
        t('💡 Click the tag row text (<code>&lt;div&gt; 320×48 …</code>) to open the details/preview dialog.</div>'),
        t('<h4>1. Buttons</h4>'),
        '<table>',
        t('<tr><td><b>↖ Parent / ↘ Child</b></td><td>Up/down the DOM tree (diagonal = tree walk); auto next sibling when no child</td></tr>'),
        t('<tr><td><b>← ↑ ↓ →</b></td><td>Elements adjacent by <b>geometry</b> (same positions as arrow keys)</td></tr>'),
        t('<tr><td><b>#</b></td><td>Quick pick: type a CSS selector or XPath to locate</td></tr>'),
        t('<tr><td><b>🖱 Restore quick-pick</b></td><td>Back to hover-to-pick (paused while locked to prevent mis-switch)</td></tr>'),
        t('<tr><td><b>👆 Simulate hover</b></td><td>Dispatches real mouseenter on the selection, JS hover expansions persist; click again to clear</td></tr>'),
        t('<tr><td><b>🔒 Allow plan</b></td><td>Page events frozen by default while locked; switch plans in the dropdown, "⚙️ Custom…" at the end opens the panel to manage custom plans</td></tr>'),
        t('<tr><td><b>✕ / ✓</b></td><td>Cancel exit / confirm send</td></tr>'),
        '</table>',
        t('<h4>2. Keyboard shortcuts</h4>'),
        '<table>',
        t('<tr><td><kbd>←</kbd> <kbd>→</kbd> <kbd>↑</kbd> <kbd>↓</kbd></td><td>Geometrically adjacent elements</td></tr>'),
        t('<tr><td><kbd>Enter</kbd></td><td>Child (none → sibling next; keep pressing to walk the DOM tree)</td></tr>'),
        t('<tr><td><kbd>Backspace</kbd> / <kbd>Delete</kbd></td><td>Parent</td></tr>'),
        t('<tr><td><kbd>PageUp</kbd> / <kbd>PageDown</kbd></td><td>Prev / next DOM sibling (buttons hidden, shortcuts only)</td></tr>'),
        t('<tr><td><kbd>Home</kbd> / <kbd>End</kbd></td><td>First / last child (as above)</td></tr>'),
        t('<tr><td><kbd>Space</kbd> / <kbd>Tab</kbd></td><td>One-key allow-plan toggle: default allow ⇄ allow all (both keys work, in case the system grabs Space)</td></tr>'),
        t('<tr><td><kbd>Esc</kbd></td><td>Close help → cancel/exit</td></tr>'),
        '</table>',
        t('<div class="dbg-help-note">Shortcuts work while the toolbar is shown; typing in inputs is never intercepted.</div>'),
        t('<h4>3. Advanced: can\'t click page buttons? Allow → trigger → switch back → select</h4>'),
        '<ol>',
        t('<li>Press <kbd>Space</kbd> or <kbd>Tab</kbd> → switch to 🔓 <b>allow all</b></li>'),
        t('<li>Click the target button → real event fires, menu opens</li>'),
        t('<li>Press <kbd>Space</kbd>/<kbd>Tab</kbd> again → back to 🔒 <b>default allow</b> (opened menus stay open)</li>'),
        t('<li>Hover/arrow-key onto menu items, <b>✓</b> to send</li>'),
        '</ol>',
        t('<div>More: <b>👆 Simulate hover</b> handles JS hover expansions (not CSS :hover); <b># quick pick</b> accepts <code>.card button</code> and <code>//div[@class="card"]</code>.</div>'),
        t('<h4>4. No keyboard (touch): tap direction buttons</h4>'),
        '<div class="dbg-help-nav-row">',
        t('<button data-dir="prev">◀ Prev</button>'),
        t('<button data-dir="next">▶ Next</button>'),
        t('<button data-dir="first">⏮ First</button>'),
        t('<button data-dir="last">⏭ Last</button>'),
        '</div>',
        t('<div class="dbg-help-note">Mapped to PageUp/PageDown/Home/End.</div>'),
      ].join('');
      // Touch navigation fallback: tappable ◀▶⏮⏭ entries (those buttons were removed from the toolbar; touch has no PageUp/PageDown/Home/End)
      body.querySelectorAll('.dbg-help-nav-row button').forEach(function (b) {
        b.addEventListener('click', function () { ctx.doNav(b.getAttribute('data-dir')); });
      });
      d.appendChild(body);

      d.style.zIndex = '2147483648'; // above the toolbar (2147483647)
      // Header drag (same pattern as the pick dialog): hold the header to move the panel; button interactions inside the header don't drag
      try {
        makePointerDrag({
          handle: head, capture: 'now', raf: true, preventStart: true,
          filter: function (e) { return !(e.target && e.target.closest && e.target.closest('button')); },
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
      // Shared floating-panel placement: bottom-center, width-capped, content-adaptive height, ≤ visual viewport (visualViewport tracking auto-registered)
      placePhysPanel(d, { visW: Math.min(480, Math.round(getPhysViewport().w) - 24), dock: 'bottom', gap: 12, maxWidth: '480px', overflowY: 'auto' });
      ctx.helpDialog = d;
      }
}
