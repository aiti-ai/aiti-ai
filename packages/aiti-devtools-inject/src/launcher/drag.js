// drag subsystem (shared gesture utilities, launcher internal common layer — same tier as dom/viewport/storage)
// Unifies the pointer gesture lifecycle of all four drag sites (fab / toolbar / HUD grip / AI window move & resize),
// maintained in one place for touch (pad/phone) correctness (each site used to roll its own, duplicating the same bug four times):
//   1. pointercancel always delivered: dual listeners at window level + handle element level — when the launcher root #__dbg_launcher's
//      stopPropagation list swallows a bubbling pointercancel, the element-level listener (target phase, runs before the root) still ends the gesture;
//      lostpointercapture is also attached as a fallback for system gestures/accidental capture release. Incomplete ending = residual gesture state/styles leave the window "stuck"
//      (measured on pad: it sticks after one drag — the browser treats the gesture as scrolling and fires cancel, but the ending listener never receives it).
//   2. Preventing touch scroll takeover relies on handle CSS touch-action:none (guaranteed by the caller in dom.js — .dbg-fab/.dbg-toolbar/
//      .dbg-hud-grip/.dbg-ai-bar/.dbg-ai-resize); pointermove's preventDefault cannot stop touch scrolling,
//      it only helps block text selection / stays compatible with mouse events.
//   3. Capture strategy: 'late' (setPointerCapture only past the threshold — pure clicks are not redirected, fab/toolbar buttons stay usable) /
//      'now' (setPointerCapture on press, HUD/AI window — events keep arriving even when the cursor/finger slides off the handle).
//   4. Optional rAF coalescing for onMove (at most once per frame, last value wins — avoids AI window frame drops from high-frequency style writes triggering reflow);
//      the pending final frame is flushed on end, so onEnd always receives the final state.
// Lifecycle: pointerdown → onStart(e) (returns a user state object, false = don't start) → onMove(ev, st, dx, dy)
//   (dx/dy = cumulative clientX/Y offset from the press point; callbacks begin only past threshold) → onEnd(ev, st, moved)
//   (pointerup / pointercancel / lostpointercapture / blur / cancel(), always delivered and idempotent).
// Note: move/up/cancel listeners are attached to window (the launcher root stopPropagation's bubbling events; attaching to document would miss them).
export function makePointerDrag(opts) {
  var handle = opts.handle;
  var threshold = opts.threshold || 0; // distance threshold (px, Manhattan distance) for "dragging"; 0 = first move counts as a drag
  var useRaf = !!opts.raf;
  var active = null; // { pid, sx, sy, user, moved, capped, frame, lastEv }

  function applyMove(a, ev) {
    try { opts.onMove(ev, a.user, ev.clientX - a.sx, ev.clientY - a.sy, a.moved); } catch (e) {}
  }
  function finish(ev) {
    if (!active) return true;
    var a = active; active = null;
    if (a.frame) { // flush the pending frame (target value queued in rAF but not yet applied — state converges to final before onEnd)
      cancelAnimationFrame(a.frame); a.frame = null;
      if (a.lastEv && a.moved) applyMove(a, a.lastEv);
    }
    try { if (opts.onEnd) opts.onEnd(ev, a.user, a.moved); } catch (e) {}
    return true;
  }

  handle.addEventListener('pointerdown', function (e) {
    if (e.button !== undefined && e.button !== 0) return; // primary button/touch only
    if (active) return; // gesture in progress (second finger in multi-touch) — don't overwrite the ongoing gesture
    if (opts.filter && !opts.filter(e)) return;
    var user = opts.onStart ? opts.onStart(e) : {};
    if (user === false) return;
    active = { pid: e.pointerId, sx: e.clientX, sy: e.clientY, user: user == null ? {} : user, moved: threshold <= 0, capped: false, frame: null, lastEv: null };
    if (opts.capture === 'now') { try { handle.setPointerCapture(e.pointerId); } catch (err) {} }
    if (opts.preventStart) { try { e.preventDefault(); } catch (err) {} } // block defaults on press (focus stealing/text selection) — don't enable where it would kill click
  });
  window.addEventListener('pointermove', function (ev) {
    if (!active || (active.pid != null && ev.pointerId !== active.pid)) return;
    if (!active.moved) {
      if (Math.abs(ev.clientX - active.sx) + Math.abs(ev.clientY - active.sy) <= threshold) return;
      active.moved = true;
    }
    try { ev.preventDefault(); } catch (err) {} // blocks touch scroll takeover/text selection (real scroll prevention relies on handle touch-action:none)
    if (opts.capture === 'late' && !active.capped) { // capture only once the drag starts: release isn't frozen by events/swallowed by root stopPropagation; pure clicks aren't captured → click lands on the button
      active.capped = true;
      try { handle.setPointerCapture(ev.pointerId); } catch (err) {}
    }
    if (!useRaf) { active.lastEv = ev; applyMove(active, ev); return; }
    active.lastEv = ev; // rAF coalescing: only remember the latest, apply once per frame
    if (active.frame) return;
    active.frame = requestAnimationFrame(function () {
      if (!active || !active.frame) return;
      active.frame = null;
      if (active.lastEv) applyMove(active, active.lastEv);
    });
  }, { passive: false });
  window.addEventListener('pointerup', function (ev) { if (active && (active.pid == null || ev.pointerId === active.pid)) finish(ev); });
  window.addEventListener('pointercancel', function (ev) { if (active) finish(ev); });
  window.addEventListener('blur', function () { finish(null); }); // window blur (alt-tab/app switch): end the gesture so state doesn't linger
  // Element-level fallback (runs before the root's bubbling stopPropagation): ending still works when a cancel bubble is swallowed by the root. All idempotent.
  handle.addEventListener('pointercancel', function (ev) { if (active && (active.pid == null || ev.pointerId === active.pid)) finish(ev); });
  // lostpointercapture is a fallback for system gestures/accidental capture release. Note it bubbles with target = the element that lost capture:
  // touch pointerdown has implicit capture (to e.target = a handle child element, e.g. the button inside the fab); late/now capture via
  // setPointerCapture(handle) first fires lostpointercapture on the child element (implicit capture handoff) which bubbles up —
  // only capture lost on handle itself must count, otherwise the drag gets killed just past the threshold (measured on pad: the drag stops after one move).
  handle.addEventListener('lostpointercapture', function (ev) {
    if (ev.target !== handle) return; // a child element lost capture (normal part of implicit→explicit handoff), not a gesture end
    if (active && (active.pid == null || ev.pointerId === active.pid)) finish(ev);
  });

  return {
    active: function () { return !!active; },
    cancel: finish, // explicit end (ESC etc.): same path as a normal end (flush pending frame + onEnd), idempotent, returns whether a gesture was actually ended
  };
}

// Drag for the centered card dialog (.dbg-dialog-card inside the .dbg-dialog flex centering container):
// hold the header (not a button) → the card switches from flex centering to fixed positioning for free dragging (shared by danger-confirm card/gesture card/settings dialog)
export function makeCardDrag(handle, card) {
  return makePointerDrag({
    handle: handle, capture: 'now', raf: true, preventStart: true,
    filter: function (e) { return !(e.target && e.target.closest && e.target.closest('button')); },
    onStart: function () {
      var r = card.getBoundingClientRect();
      card.style.position = 'fixed'; // leaves flex centering (.dbg-dialog has no transform → positioned relative to the viewport)
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
