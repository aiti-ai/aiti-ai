// drag 子系统（公共手势工具，launcher 内部公共层——与 dom/viewport/storage 同类）
// 统一四处拖拽（fab / 工具条 / HUD 抓手 / AI 窗拖动与缩放）的 pointer 手势生命周期，
// 单点维护触屏（pad/手机）正确性（原各写各的，同一 bug 重复四份）：
//   1. pointercancel 必达：window 级 + 把手元素级双监听——launcher 根 #__dbg_launcher 的
//      stopPropagation 列表吞掉冒泡的 pointercancel 时，元素级监听（target 相，先于根执行）保证结束；
//      另挂 lostpointercapture 兜底系统手势/误触释放捕获。结束不到位 = 手势状态/样式残留窗口"卡住"
//      （pad 实测：拖一下就卡住——浏览器把手势当滚动触发 cancel，结束监听却收不到）。
//   2. 触屏滚动接管靠把手 CSS touch-action:none（调用方在 dom.js 保证——.dbg-fab/.dbg-toolbar/
//      .dbg-hud-grip/.dbg-ai-bar/.dbg-ai-resize）；pointermove 的 preventDefault 管不了触屏滚动，
//      只辅助挡文本选择/兼容鼠标事件。
//   3. 捕获策略：'late'（超阈值才捕获——纯点击的 click 不被重定向，fab/工具条按钮可用）/
//      'now'（按下即捕获，HUD/AI 窗——光标/手指滑出把手也持续收到事件）。
//   4. onMove 可选 rAF 合并（每帧最多一次、末值生效——AI 窗防高频 style 写入重排掉帧）；
//      结束时冲刷未应用的末帧，onEnd 拿到的必是最终状态。
// 生命周期：pointerdown → onStart(e)（返回用户状态对象，false=不启动）→ onMove(ev, st, dx, dy)
//   （dx/dy=clientX/Y 相对按下点累计位移；超 threshold 才开始回调）→ onEnd(ev, st, moved)
//   （pointerup / pointercancel / lostpointercapture / blur / cancel()，必达且幂等）。
// 注意：move/up/cancel 监听挂 window（launcher 根会 stopPropagation 冒泡事件，挂 document 收不到）。
export function makePointerDrag(opts) {
  var handle = opts.handle;
  var threshold = opts.threshold || 0; // 判定"拖动"的位移阈值（px，曼哈顿距离）；0=首个 move 即拖动
  var useRaf = !!opts.raf;
  var active = null; // { pid, sx, sy, user, moved, capped, frame, lastEv }

  function applyMove(a, ev) {
    try { opts.onMove(ev, a.user, ev.clientX - a.sx, ev.clientY - a.sy, a.moved); } catch (e) {}
  }
  function finish(ev) {
    if (!active) return true;
    var a = active; active = null;
    if (a.frame) { // 冲刷末帧（rAF 排队中还没应用的目标值——onEnd 前状态收敛到最终）
      cancelAnimationFrame(a.frame); a.frame = null;
      if (a.lastEv && a.moved) applyMove(a, a.lastEv);
    }
    try { if (opts.onEnd) opts.onEnd(ev, a.user, a.moved); } catch (e) {}
    return true;
  }

  handle.addEventListener('pointerdown', function (e) {
    if (e.button !== undefined && e.button !== 0) return; // 仅主键/触摸
    if (active) return; // 手势进行中（多点触控第二指）——不覆盖进行中的手势
    if (opts.filter && !opts.filter(e)) return;
    var user = opts.onStart ? opts.onStart(e) : {};
    if (user === false) return;
    active = { pid: e.pointerId, sx: e.clientX, sy: e.clientY, user: user == null ? {} : user, moved: threshold <= 0, capped: false, frame: null, lastEv: null };
    if (opts.capture === 'now') { try { handle.setPointerCapture(e.pointerId); } catch (err) {} }
    if (opts.preventStart) { try { e.preventDefault(); } catch (err) {} } // 按下即挡默认（焦点夺取/文本选择）——会杀 click 的场景勿开
  });
  window.addEventListener('pointermove', function (ev) {
    if (!active || (active.pid != null && ev.pointerId !== active.pid)) return;
    if (!active.moved) {
      if (Math.abs(ev.clientX - active.sx) + Math.abs(ev.clientY - active.sy) <= threshold) return;
      active.moved = true;
    }
    try { ev.preventDefault(); } catch (err) {} // 挡触屏滚动接管/文本选择（真正防滚动靠把手 touch-action:none）
    if (opts.capture === 'late' && !active.capped) { // 拖动开始才捕获：释放不被事件冻结/根 stopPropagation 吞；纯点击不捕获 → click 落按钮
      active.capped = true;
      try { handle.setPointerCapture(ev.pointerId); } catch (err) {}
    }
    if (!useRaf) { active.lastEv = ev; applyMove(active, ev); return; }
    active.lastEv = ev; // rAF 合并：只记最新，每帧应用一次
    if (active.frame) return;
    active.frame = requestAnimationFrame(function () {
      if (!active || !active.frame) return;
      active.frame = null;
      if (active.lastEv) applyMove(active, active.lastEv);
    });
  }, { passive: false });
  window.addEventListener('pointerup', function (ev) { if (active && (active.pid == null || ev.pointerId === active.pid)) finish(ev); });
  window.addEventListener('pointercancel', function (ev) { if (active) finish(ev); });
  window.addEventListener('blur', function () { finish(null); }); // 窗口失焦（alt-tab/切应用）：结束手势，状态不残留
  // 元素级兜底（先于根的冒泡 stopPropagation 执行）：cancel 冒泡被根吞时也能结束。均幂等。
  handle.addEventListener('pointercancel', function (ev) { if (active && (active.pid == null || ev.pointerId === active.pid)) finish(ev); });
  // lostpointercapture 兜底系统手势/误触释放捕获。注意它冒泡且 target=失去捕获的元素：
  // 触屏 pointerdown 有隐式捕获（到 e.target=把手子元素，如 fab 里的 button）；late/now 捕获
  // setPointerCapture(handle) 会先在子元素上触发 lostpointercapture（隐式捕获转移）并冒泡上来——
  // 必须只认 handle 自身，否则拖动刚超阈值就被误杀（pad 实测：拖一下就停）。
  handle.addEventListener('lostpointercapture', function (ev) {
    if (ev.target !== handle) return; // 子元素失去捕获（隐式→显式转移的正常过程），不算手势结束
    if (active && (active.pid == null || ev.pointerId === active.pid)) finish(ev);
  });

  return {
    active: function () { return !!active; },
    cancel: finish, // 主动结束（ESC 等）：与正常结束同链路（冲刷末帧 + onEnd），幂等，返回是否确有手势被结束
  };
}

// 居中卡片弹窗（.dbg-dialog-card 于 .dbg-dialog flex 居中容器内）拖拽：
// 按住头部（非按钮）→ 卡片从 flex 居中改为固定定位自由拖动（危险确认卡/手势卡/设置弹窗共用）
export function makeCardDrag(handle, card) {
  return makePointerDrag({
    handle: handle, capture: 'now', raf: true, preventStart: true,
    filter: function (e) { return !(e.target && e.target.tagName === 'BUTTON'); },
    onStart: function () {
      var r = card.getBoundingClientRect();
      card.style.position = 'fixed'; // 脱离 flex 居中（.dbg-dialog 无 transform → 相对视口定位）
      card.style.left = r.left + 'px';
      card.style.top = r.top + 'px';
      card.style.margin = '0';
      card.classList.add('dbg-dragging');
      return { left: r.left, top: r.top };
    },
    onMove: function (ev, st, dx, dy) {
      var nl = Math.min(Math.max(0, st.left + dx), Math.max(40, (window.innerWidth || 0) - 60));
      var nt = Math.min(Math.max(0, st.top + dy), Math.max(24, (window.innerHeight || 0) - 40));
      card.style.left = nl + 'px';
      card.style.top = nt + 'px';
    },
    onEnd: function () { card.classList.remove('dbg-dragging'); },
  });
}
