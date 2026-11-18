// interact subsystem (ctx mode): interaction tools for AI ↔ human collaboration on the page
//   - Browser notification: Notification API + title flashing + attention beep when an interaction arrives (the user may be on another tab)
//   - pick_element: collapse the AI window → enter pick mode (host + iframe broadcast) → show the pick panel (✓ confirm / ✕ reject / timeout)
//   - Other Q&A (confirm/choose/input/presence): the AI window renders answer cards (ai.html); host notification;
//     when the AI window is not connected, the host falls back to rendering the Q&A panel
// Result back to bridge: window.postMessage dbg_mcp_result → MINI client postBridgeResult → POST /bridge/result
import { el, escapeHtml, elSvg, LUCIDE } from './dom.js';
import { dbgMsg } from './protocol.js';
import { isTouchDevice, detectScreenMode, getPhysViewport, capVisW, placePhysPanel, _fixedVisual } from './viewport.js';
import { makePointerDrag } from './drag.js';
import { t } from './i18n.js';

// Human-readable answer description (copy text for the async interaction user_answer event).
// The AI window cockpit.html has a same-semantics implementation (consumes the whole result incl. status); this adapts the launcher-side input (takes the value layer directly),
// and covers multi-select (indexes/labels) — called from the finishAsk async branch, entered only in the answered state, so no status branch is needed.
function describeAnswer(kind, v) {
  v = v || {};
  if (kind === 'confirm') return v.approved === false ? t('❌ No') : t('✅ Yes');
  if (kind === 'choose') {
    if (Array.isArray(v.indexes)) return (v.labels && v.labels.length) ? v.labels.join('、') : (v.indexes.length + t(' items'));
    return (v.custom || v.index === -1) ? t('✍️ None of these') : String(v.label != null ? v.label : v.index);
  }
  if (kind === 'input') return String(v.text || '');
  if (kind === 'presence') return v.present === false ? t('⏳ Later') : t('🙋 I\'m here');
  if (kind === 'pick_element') {
    if (v.tag || v.text) return '🎯 <' + (v.tag || '?') + '>' + (v.text ? ' ' + String(v.text).trim().slice(0, 40) : '');
    return t('🎯 Element selected');
  }
  return t('✅ Answered');
}

export function initInteract(ctx) {
  // HUD small-screen offset memory (▲ move up to dodge occlusion / ▼ move down back to bottom → persisted in localStorage)
  ctx.hudSmallOffset = 0;
  try { ctx.hudSmallOffset = parseInt(localStorage.getItem('__dbg_hud_off') || '0', 10) || 0; } catch (e) {}
  ctx.adjustHudOffset = function (dy) {
    try {
      var vp = getPhysViewport();
      var visVh = _fixedVisual ? ((window.visualViewport && window.visualViewport.height) || window.innerHeight)
                               : (window.innerHeight * vp.scaleY);
      // Offset cap = visible height - bottom margin (prevents pushing the HUD off the top of the screen)
      var maxOff = Math.max(0, Math.round(visVh) - 120);
      ctx.hudSmallOffset = Math.min(Math.max((ctx.hudSmallOffset || 0) + dy, 0), maxOff);
      try { localStorage.setItem('__dbg_hud_off', String(ctx.hudSmallOffset)); } catch (e) {}
    } catch (e) {}
  };
  // Transient toast: notifies the user when an interaction arrives, auto-dismisses after a few seconds — non-blocking, no confirm dialog (per user request)
  ctx.showPickToast = function (html, ms) {
    try {
      var olds = ctx.root.querySelectorAll('.dbg-pick-toast');
      for (var i = 0; i < olds.length; i++) { if (olds[i].parentNode) olds[i].parentNode.removeChild(olds[i]); }
      var t = el('div', { class: 'dbg-pick-toast' });
      t.innerHTML = html;
      ctx.root.appendChild(t);
      placePhysPanel(t, { visW: Math.min(360, Math.round(getPhysViewport().w) - 24), dock: 'bottom', gap: 12, offsetY: 64, minH: 30, maxWidth: '360px', overflowY: '' });
      setTimeout(function () {
        t.style.opacity = '0';
        setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 450);
      }, ms || 4500);
    } catch (e) {}
  };
  // Small-screen pick entry: bottom toast hint "click an element to select" (called uniformly at the inspect entry)
  ctx.showPickHint = function () {
    try {
      if (!detectScreenMode().small) return;
      ctx.showPickToast(t('🖱 Click a page element to select<br><span style="color:#a5b4fc;font-size:11px">Confirm on the toolbar with ✓ after picking</span>'));
    } catch (e) {}
  };

  // ---- Agent session source (from <agentId> · session <short> · <name> · <Browser · OS>) ----
  // Reads the source fields the bridge adds to interaction/notify/exec envelopes (agentId = agentKey,
  // agentName = registered display name, targetDevice = browser · OS short label). Order per design:
  // id first, session name last. Every segment is optional — missing data just drops the segment;
  // no agentId at all returns null (caller renders nothing). key carries the full agentKey.
  ctx.formatAgentSrc = function (it) {
    var ak = it && it.agentId ? String(it.agentId).trim() : '';
    if (!ak) return null;
    var name = it && it.agentName ? String(it.agentName).trim() : '';
    var parts = ak.split('/');
    var aid = parts[0] || ak;
    var sid = parts.slice(1).join('/');
    var sidShort = sid && sid.length > 10 ? sid.slice(0, 8) + '…' : sid;
    var dev = it && it.targetDevice ? String(it.targetDevice).trim() : '';
    var segs = ['from ' + aid];
    if (sidShort) segs.push(t('session') + ' ' + sidShort);
    if (name && name !== aid) segs.push(name); // session display name last (user preference)
    if (dev) segs.push(dev);
    return { key: ak, aid: aid, sid: sid, name: name, dev: dev, text: segs.join(' · ') };
  };
  // ⓘ title-bar button (compact — head space is tight, per user feedback): click toggles an info
  // block in the card body (buildAgentSrcInfo) with full session id + one-click copy of the key.
  ctx.agentSrcInfoBtn = function (it) {
    var src = ctx.formatAgentSrc(it);
    if (!src) return null;
    var btn = el('button', { class: 'dbg-src-info-btn', title: t('Source session info') }, ['ⓘ']);
    btn.style.cssText = 'border:none;background:none;color:#93c5fd;font-size:13px;cursor:pointer;padding:2px 5px;line-height:1;font-weight:700';
    btn.__agentSrc = src;
    return btn;
  };
  // Info block: key/value rows + copy button (appended to the card body when ⓘ is toggled on)
  ctx.buildAgentSrcInfo = function (src) {
    var wrap = el('div', { class: 'dbg-src-info' });
    wrap.style.cssText = 'margin-top:6px;padding:7px 9px;border:1px solid rgba(148,163,184,.3);border-radius:8px;background:rgba(15,23,42,.45);font-size:11px;line-height:1.7;color:#cbd5e1';
    var head = el('div', { style: 'font-weight:700;color:#93c5fd;margin-bottom:2px' }, [t('🧠 Source session')]);
    wrap.appendChild(head);
    var row = function (k, v) {
      var r = el('div', {});
      var kb = el('span', { style: 'color:#94a3b8;display:inline-block;min-width:52px' }, [k]);
      var vb = el('span', { style: 'word-break:break-all;user-select:text' }, [v]);
      r.appendChild(kb); r.appendChild(vb);
      wrap.appendChild(r);
      return vb;
    };
    row('agent', src.aid);
    if (src.sid) { var sidV = row(t('session'), src.sid); sidV.title = src.key; }
    if (src.name && src.name !== src.aid) row('name', src.name);
    if (src.dev) row('device', src.dev);
    var copyBtn = el('button', { style: 'margin-top:4px;border:1px solid rgba(148,163,184,.4);border-radius:6px;background:none;color:#93c5fd;font-size:10px;cursor:pointer;padding:3px 8px' }, [t('📋 Copy session key')]);
    copyBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (ctx.copyToClipboard) ctx.copyToClipboard(src.key, function (ok) { copyBtn.textContent = ok ? t('✓ Copied') : '✕'; setTimeout(function () { copyBtn.textContent = t('📋 Copy session key'); }, 1200); });
    });
    wrap.appendChild(copyBtn);
    return wrap;
  };
  // Toggle helper shared by all panels: appends/removes the info block in the card body, then lets
  // the caller reflow (placePhysPanel measures content height).
  ctx.toggleAgentSrcInfo = function (btn, bodyEl, reflow) {
    var existing = bodyEl.querySelector('.dbg-src-info');
    if (existing) { existing.parentNode.removeChild(existing); if (reflow) reflow(false); return; }
    bodyEl.appendChild(ctx.buildAgentSrcInfo(btn.__agentSrc));
    if (reflow) reflow(true);
  };
  // Shared-singleton card binding (danger confirm/gesture): (re)binds the ⓘ button per-show and
  // collapses any open info block first. Flex-centered .dbg-dialog cards reflow automatically,
  // so no reflow callback is needed; sourceless payloads just remove the button.
  ctx.bindAgentSrcInfoButton = function (card, it) {
    var head = card.querySelector('.dbg-dialog-head');
    var body = card.querySelector('.dbg-dialog-body');
    if (!head || !body) return null;
    var old = body.querySelector('.dbg-src-info');
    if (old) old.parentNode.removeChild(old); // per-show reset: previous block never lingers
    var btn = head.querySelector('.dbg-src-info-btn');
    var src = ctx.formatAgentSrc(it);
    if (!src) { if (btn && btn.parentNode) btn.parentNode.removeChild(btn); return null; }
    if (!btn) {
      btn = el('button', { class: 'dbg-src-info-btn', title: t('Source session info') }, ['ⓘ']);
      btn.style.cssText = 'border:none;background:none;color:#93c5fd;font-size:16px;cursor:pointer;padding:0 6px;line-height:1;font-weight:700';
      head.appendChild(btn);
    }
    btn.__agentSrc = src;
    btn.onclick = function (e) { e.stopPropagation(); ctx.toggleAgentSrcInfo(btn, body, null); };
    return btn;
  };

  // (The legacy makeCopyableBlock floating copy button was removed: Q&A panels now put a lucide copy
  // button in the header -- same interaction as the notify card; the body stays plain selectable text.)

  // ---- Browser notification (Notification API + title flashing + attention beep) ----
  // opts.noToastFallback: skip the in-page toast fallback (used by the notify path, which always also
  // renders the persistent notify card -- toast + card at the same dock spot would duplicate content);
  // hidden-tab title flash + beep are kept regardless (they do not overlap the card).
  ctx.NOTIFY = { timer: null, origTitle: document.title, audio: null };
  ctx.notifyUser = function (title, body, opts) {
    opts = opts || {};
    var shown = false; // whether the system notification actually popped (granted + created successfully)
    if ('Notification' in window) {
      if (Notification.permission === 'granted') {
        try {
          var n = new Notification(title, { body: body || '', tag: 'aiti-interact', renotify: true });
          n.onclick = function () { try { window.focus(); n.close(); } catch (e) {} };
          shown = true;
        } catch (e) {}
      } else if (Notification.permission !== 'denied') {
        // Undecided: silently request permission once (the browser may require a user gesture; failure does not block the interaction panel itself)
        try { Notification.requestPermission().then(function (p) { if (p === 'granted') ctx.notifyUser(title, body); }); } catch (e) {}
      }
    }
    // Fallback degradation: the system notification did not pop (permission denied/unavailable) → in-page toast fallback so the user definitely sees it;
    // when the page is hidden, also flash the title + beep (the toast is invisible from other tabs)
    if (!shown && !opts.noToastFallback) {
      try { ctx.showPickToast('🔔 ' + title + (body ? '<br>' + body : ''), 6000); } catch (e) {}
    }
    if (!shown && document.hidden) { ctx.flashTitle('🔔 ' + title); ctx.beepAttention(); }
  };
  ctx.flashTitle = function (prefix) {
    var orig = ctx.NOTIFY.origTitle || document.title;
    var on = true;
    if (ctx.NOTIFY.timer) clearInterval(ctx.NOTIFY.timer);
    ctx.NOTIFY.timer = setInterval(function () {
      document.title = on ? prefix + ' · ' + orig : orig;
      on = !on;
    }, 900);
    setTimeout(ctx.stopTitleFlash, 30000);
  };
  ctx.stopTitleFlash = function () {
    if (ctx.NOTIFY.timer) { clearInterval(ctx.NOTIFY.timer); ctx.NOTIFY.timer = null; document.title = ctx.NOTIFY.origTitle || ''; }
  };
  window.addEventListener('focus', ctx.stopTitleFlash);
  ctx.beepAttention = function () {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!ctx.NOTIFY.audio) ctx.NOTIFY.audio = new AC();
      var ac = ctx.NOTIFY.audio;
      if (ac.state === 'suspended') ac.resume();
      [[880, 0, .12], [660, .16, .18]].forEach(function (t) {
        var o = ac.createOscillator(), g = ac.createGain();
        o.frequency.value = t[0]; g.gain.value = .06;
        o.connect(g); g.connect(ac.destination);
        o.start(ac.currentTime + t[1]); o.stop(ac.currentTime + t[1] + t[2]);
      });
    } catch (e) {}
  };

  // ---- Interaction result back to bridge (AI main window replies directly / host relays via the AI window → POST /bridge/result) ----
  ctx.sendInteractionResult = function (requestId, result) {
    // Bridge return priority:
    //   1) This window has a BridgeClient (the AI main window is bridge-connected, it is itself a bridge endpoint) → postResult directly (empty pageId goes through the compat token path, bypassing non-idRegistry instances)
    //   2) Host page (not bridge-connected) → postToAi relays via the AI window → AI window BridgeClient → bridge
    // Fix: previously always postToAi — when the AI main window has no popup/iframe target it silently drops → the AI still times out after the user answers.
    var ok = result.status !== 'timeout';
    try {
      if (global.BridgeClient && typeof global.BridgeClient.postResult === 'function') { global.BridgeClient.postResult(requestId, ok, result); return; }
    } catch (e) {}
    try { ctx.postToAi(dbgMsg({ type: 'dbg_mcp_result', payload: { requestId: requestId, ok: ok, result: result } })); } catch (e) {}
  };
  // Host → bridge events (via the AI window's BridgeClient.postEvent → POST /bridge/event — the AI window is the bridge's only browser endpoint,
  // the page has zero direct connection to the bridge; events are dropped when the AI window is closed/not ready, and the client-side ring buffer does not replay them (rate control is bridge-side))
  ctx.postBridgeEvent = function (type, payload) {
    try { ctx.postToAi(dbgMsg({ type: 'dbg_bridge_event', payload: { type: type, payload: payload || {} } })); } catch (e) {}
  };
  // Interaction countdown control (pause/resume): via MINI client postBridgeControl → POST /bridge/interaction (the server pauses its countdown in sync)
  ctx.sendInteractionControl = function (requestId, action) {
    // Same protocol as above: control always goes back to the bridge via the AI window, never delivered to itself
    try { ctx.postToAi(dbgMsg({ type: 'dbg_mcp_interaction_control', payload: { requestId: requestId, action: action } })); } catch (e) {}
  };

  // Interaction timeout model (timeout optional, not the default): AI omits timeout → wait forever — the panel stays persistent until the user acts, no countdown, no timeout;
  // AI explicitly passes timeout → the panel shows a ⏱ countdown (pausable, server keeps time in sync), settling as timeout when it expires.
  // Each panel branches on it.timeoutMs>0 by itself; no shared control needed.

  // ---- Pick panel state (pick_element): panel + two-zone picking ----
  ctx.pickPanel = null;
  ctx.hideAiForPick = function () { ctx.aiOpen = false; ctx.showAi(false); ctx.aiBtn.classList.remove('dbg-on'); };
  ctx.exitPickInspect = function () {
    // Exit pick mode (host/iframe client exit + toolbar hidden) + restore the AI window
    try { ctx.postToAi({ type: 'dbg_ai_inspect_off', payload: {} }); } catch (e) {}
    try { ctx.broadcast({ type: 'dbg_ai_pick', payload: { active: false } }); } catch (e) {}
    try { ctx.broadcast({ type: 'dbg_exit_inspector' }); } catch (e) {}
    try { if (window.__dbg && typeof window.__dbg.exitInspector === 'function') window.__dbg.exitInspector(); } catch (e) {}
    ctx.aiInspectActive = false;
    ctx.inspectorOn = false;
    if (ctx.inspBtn) ctx.inspBtn.classList.remove('dbg-on');
    try { ctx.deactivateNestedIframes(); } catch (e) {}
    if (ctx.root) { var tbEl = ctx.root.querySelector('.dbg-toolbar'); if (tbEl) tbEl.classList.remove('dbg-on'); }
    ctx.aiOpen = true;
    ctx.ensureAi();
    ctx.showAi(true);
    ctx.aiBtn.classList.add('dbg-on');
  };
  // Get the current selection payload (iframe clients first, host self as fallback, then the hover cache as final fallback)
  ctx.getPickPayload = function () {
    try {
      var frames = ctx.listFrames();
      for (var i = 0; i < frames.length; i++) {
        var fw = frames[i] && frames[i].win;
        if (fw && fw.__dbg && typeof fw.__dbg.getSelectionPayload === 'function') {
          var p = fw.__dbg.getSelectionPayload();
          if (p) return p;
        }
      }
    } catch (e) {}
    try {
      if (window.__dbg && typeof window.__dbg.getSelectionPayload === 'function') {
        var q = window.__dbg.getSelectionPayload();
        if (q) return q;
      }
    } catch (e) {}
    return (ctx.pickPanel && ctx.pickPanel.el) || ctx.lastSelfPayload || ctx.lastPayload || null;
  };
  ctx.finishPickPanel = function (result) {
    if (!ctx.pickPanel) return;
    var pp = ctx.pickPanel;
    ctx.pickPanel = null;
    clearInterval(pp.timer);
    if (pp.dialog && pp.dialog.parentNode) pp.dialog.parentNode.removeChild(pp.dialog);
    try { ctx.exitPickInspect(); } catch (e) {}
    // Clear the space the small-screen HUD padded open (exitPickInspect does not go through exitInspector, so clean it up here)
    if (document.body.style.paddingBottom) document.body.style.paddingBottom = '';
    // Exit pick: hide the HUD (hover-show restore is controlled by the original updateHud)
    if (ctx.hud) { try { ctx.hud.style.opacity = '0'; } catch (e) {} }
    result.tookMs = Date.now() - pp.startedAt;
    if (pp.silent) return; // already settled server-side (timeout/cancel/agent stop) — just close the panel, no bridge return
    if (pp.it && pp.it.async) {
      // Async: the candidate already entered the AI pending area on confirm — just close the window/clear the HUD (the bridge already returned async; send/decline messages are posted by the matching branch via postBridgeEvent)
      ctx.addMsg('sys', result.status === 'answered' ? t('🎯 Selected (candidate in AI pending area, click [element N] to send)') : (result.status === 'rejected' ? t('✕ User cancelled/declined: ') + (result.reason || '') : t('⏱ Pick timeout (no user response)')));
      return;
    }
    ctx.sendInteractionResult(pp.requestId, result);
    ctx.addMsg('sys', result.status === 'answered' ? t('🎯 User picked an element (sent to AI)') : (result.status === 'rejected' ? t('✕ User declined selection: ') + (result.reason || '') : t('⏱ Pick timeout (no user response)')));
  };
  // Server-side settlement (agent stop/cancel) → silently close the pick panel (no bridge return — the bridge already settled; sending back would report "no pending")
  ctx.closePickPanel = function (requestId) {
    var pp = ctx.pickPanel;
    if (pp && pp.requestId === requestId) { pp.silent = true; ctx.finishPickPanel({ status: 'cancelled', error: t('AI stopped') }); }
  };
  ctx.showPickElementPanel = function (requestId, it) {
    // Dedup: duplicate delivery of the same requestId (bridge dual-writer/dual-relay fallback) → skip, otherwise the second one would instantly reject the first ('interrupted by a new interaction')
    if (ctx.pickPanel && ctx.pickPanel.requestId === requestId) return;
    if (ctx.pickPanel) ctx.finishPickPanel({ status: 'rejected', reason: t('Interrupted by new interaction') });
    // Clean up possibly leftover dialogs (an interrupted/timed-out MCP call may leave an uncleaned confirm dialog — the user sees several stacked)
    try {
      var _olds = ctx.root.querySelectorAll('.dbg-pick-dialog');
      for (var _i = 0; _i < _olds.length; _i++) { if (_olds[_i].parentNode) _olds[_i].parentNode.removeChild(_olds[_i]); }
    } catch (e) {}
    // Do not wrap updateHud — the pick UI uses the existing toolbar (target.js hover/lock + ✓ confirm), one inspect system (per user request)
    ctx.selfAiRequested = false; // bridge pick_element interaction (AI-initiated): results/candidates belong to the AI window (original logic: it belongs to whoever triggered it)
    var timeoutMs = parseInt(it.timeoutMs, 10) > 0 ? parseInt(it.timeoutMs, 10) : 0; // timeout optional: only >0 starts the countdown/expiry timeout; 0 = wait forever (panel stays persistent until the user acts)
    var startedAt = Date.now();
    var asyncMode = !!it.async;
    // Confirm dialog (tells the user a pick is coming: start now / not now) — the 4.5s toast disappears too fast to notice (user-tested), dialog restored;
    //   pick mode (toolbar hover/lock) starts only after confirmation; subsequent picking/results all go through the existing toolbar (one inspect system)
    var dialog = el('div', { class: 'dbg-pick-dialog' });
    var head = el('div', { class: 'dbg-pick-head' });
    head.appendChild(el('span', { class: 'dbg-pick-title' }, [t('🎯 AI asks you to pick a page element')]));
    var noTimeout = !(timeoutMs > 0); // wait forever: no countdown/pause (⏸ hidden — nothing to pause), static ♾ in the header marks the panel persistent until the user acts
    var timerSpan = el('span', { style: 'font-weight:400;color:#93c5fd;font-size:11px' }, [noTimeout ? t('♾ Waiting') : ('⏱ ' + Math.ceil(timeoutMs / 1000) + 's')]);
    var pauseBtn = el('button', { title: t('Pause countdown') }, ['⏸']);
    if (noTimeout) pauseBtn.style.display = 'none';
    var minBtn = el('button', { title: t('Temporarily hide (click to restore)') }, [t('👁 Hide')]);
    head.appendChild(timerSpan);
    head.appendChild(pauseBtn);
    head.appendChild(minBtn);
    dialog.appendChild(head);
    var body = el('div', { class: 'dbg-pick-body' });
    if (it.prompt) body.appendChild(el('div', { style: 'white-space:pre-wrap' }, [it.prompt]));
    body.appendChild(el('div', { style: 'color:#94a3b8;line-height:1.5;margin-top:4px' }, [t('AI needs you to pick a page element. Click "Start selecting" to begin — hover to highlight, click to lock, then confirm on the toolbar.')]));
    var c = el('div', { style: 'margin-top:8px;display:flex;gap:6px;justify-content:center' });
    var startBtn = el('button', { class: 'dbg-pick-ok' }, [t('🖱 Start selecting')]);
    var laterBtn = el('button', { class: 'dbg-pick-cancel' }, [t('⏳ Not now')]);
    c.appendChild(laterBtn); c.appendChild(startBtn); // mobile convention: primary action (start selecting now) on the right
    body.appendChild(c);
    dialog.appendChild(body);
    ctx.root.appendChild(dialog);
    dialog.style.zIndex = '2147483648'; // cover the toolbar (2147483647) — otherwise the toolbar covers the button area and it cannot be clicked
    // Shared floating-layer positioning (placePhysPanel — same visual coordinate algorithm as the AI window/HUD): bottom-centered, width capped at 420, content-fit height, ≤ visible area (offsetY lifts it, same as above)
    placePhysPanel(dialog, { visW: Math.min(420, Math.round(getPhysViewport().w) - 24), dock: 'bottom', gap: 12, offsetY: 64, minH: 40, maxWidth: '420px', overflowY: 'auto' });
    try { ctx.dodgeToolbarAboveDialog(dialog); } catch (e) {} // toolbar already shown → dodge immediately (covers the no-selection/dragged cases; re-anchor is a no-op for them)
    // Drag to move: hold the header (non-button) to drag the panel (makePointerDrag — same infrastructure as the AI window/fab/Q&A panel)
    try {
      makePointerDrag({
        handle: head, capture: 'now', raf: true, preventStart: true,
        filter: function (e) { return !(e.target && e.target.closest && e.target.closest('button')); },
        onStart: function () {
          dialog.classList.add('dbg-dragging');
          return { left: dialog.offsetLeft || 0, top: dialog.offsetTop || 0 };
        },
        onMove: function (ev, st, dx, dy) {
          var nl = Math.min(Math.max(0, st.left + dx), Math.max(40, (window.innerWidth || 0) - 60));
          var nt = Math.min(Math.max(0, st.top + dy), Math.max(24, (window.innerHeight || 0) - 40));
          dialog.style.left = nl + 'px';
          dialog.style.top = nt + 'px';
          dialog.style.right = 'auto';
          dialog.style.bottom = 'auto';
        },
        onEnd: function () { dialog.classList.remove('dbg-dragging'); },
      });
    } catch (e) {}
    minBtn.addEventListener('click', function () {
      var hidden = body.style.display === 'none';
      body.style.display = hidden ? '' : 'none';
      minBtn.textContent = hidden ? t('👁 Hide') : t('👁 Show');
      if (dialog.parentNode) placePhysPanel(dialog, { visW: Math.min(420, Math.round(getPhysViewport().w) - 24), dock: 'bottom', gap: 12, offsetY: 64, minH: 40, maxWidth: '420px', overflowY: 'auto' });
      // offsetY must be kept: without it the panel sits flush at the very bottom of the screen, right on top of the bottom-docked inspect toolbar
    });
    function startInspect() {
      ctx.hideAiForPick(); // hide the AI window (the user goes straight to picking)
      ctx.aiInspectActive = true;
      ctx.selfEngaged = false;
      ctx.enterSelfClient(isTouchDevice() ? 'touch' : 'mouse');
      ctx.activateNestedIframes(isTouchDevice() ? 'touch' : 'mouse');
      ctx.broadcast({ type: 'dbg_enter_inspector', payload: { mode: 'mouse' } });
      ctx.broadcast({ type: 'dbg_ai_pick', payload: { active: true } });
      ctx.addMsg('sys', t('🎯 Pick mode (') + String(it.prompt || '').slice(0, 40) + t(') — hover to highlight, click to lock, confirm on the toolbar.'));
      try { if (ctx.showPickHint) ctx.showPickHint(); } catch (e) {} // small-screen bottom toast: click an element to select
    }
    startBtn.addEventListener('click', function () {
      try { if (dialog.parentNode) dialog.parentNode.removeChild(dialog); } catch (e) {}
      startInspect();
      ctx.pickPanel.dialog = null; // confirm dialog already removed — finishPickPanel no longer touches it
    });
    laterBtn.addEventListener('click', function () { ctx.finishPickPanel({ status: 'rejected', reason: t('User chose not to select now') }); });
    // Countdown (pausable/resumable: after ⏸ the server pauses its timer in sync)
    var deadline = Date.now() + timeoutMs;
    var paused = false;
    var remainingMs = timeoutMs; // freeze remaining time while paused; rebuild the deadline from it on resume (the original logic reused the stale deadline, losing the paused duration → the number jumped after resume)
    function tickCountdown() {
      if (paused) return;
      var left = Math.max(0, deadline - Date.now());
      if (timerSpan) timerSpan.textContent = '⏱ ' + Math.ceil(left / 1000) + 's';
      if (left <= 0) ctx.finishPickPanel({ status: 'timeout', error: t('No user response (away)') });
    }
    if (!noTimeout) pauseBtn.addEventListener('click', function () {
      paused = !paused;
      if (paused) {
        remainingMs = Math.max(0, deadline - Date.now());
        if (timerSpan) timerSpan.textContent = t('⏸ Paused (') + Math.ceil(remainingMs / 1000) + 's）';
        pauseBtn.textContent = '▶';
      } else {
        deadline = Date.now() + remainingMs;
        if (timerSpan) timerSpan.textContent = '⏱ ' + Math.ceil(remainingMs / 1000) + 's';
        pauseBtn.textContent = '⏸';
      }
      ctx.sendInteractionControl(requestId, paused ? 'pause' : 'resume');
    });
    ctx.pickPanel = { requestId: requestId, it: it, dialog: dialog, timerSpan: timerSpan, startedAt: startedAt, el: null, asyncMode: asyncMode, phase: 'confirm' };
    ctx.pickPanel.timer = noTimeout ? null : setInterval(tickCountdown, 500); // wait forever has no timer (finishPickPanel clearInterval(null) is safe)
  };

  // pick_element interaction: once a pick is locked, the UI uses the existing toolbar (target.js hover/lock + ✓ confirm) — one inspect system.
  //   Here we only record the current selection + result description (for the toolbar ✓ confirm to send); no second pick HUD is rendered (removed per user request).
  ctx.updatePickPanelLabel = function (p) {
    if (!ctx.pickPanel || !p) return;
    ctx.pickPanel.el = p;
    if (p && p.engaged) {
      ctx.pickPanel.resultDesc = '<' + (p.tag || '?') + '>'
        + (p.text ? ' ' + String(p.text).trim().slice(0, 50) : '')
        + (p.xpath ? ' · ' + String(p.xpath).slice(0, 60) : '');
    }
  };
  // ---- Fallback Q&A panel (host renders directly when the AI window is not connected: confirm/choose/input/presence) ----
  ctx.showHostAskPanel = function (requestId, it) {
    // Dedup: duplicate delivery of the same requestId (bridge dual-writer/dual-relay fallback) → skip, do not stack two panels (the user would see two, click one and leave the other behind)
    if (ctx.hostAskPanels && ctx.hostAskPanels[requestId]) return;
    var kind = it.kind || 'confirm';
    var timeoutMs = parseInt(it.timeoutMs, 10) > 0 ? parseInt(it.timeoutMs, 10) : 0; // timeout optional: only >0 starts the countdown/expiry timeout; 0 = wait forever (panel stays persistent until the user acts)
    var startedAt = Date.now();
    var seq = (ctx.askPanelSeq = (ctx.askPanelSeq || 0) + 1); // panel sequence number: keyboard shortcuts respond only to the newest panel (prevents double responses when multiple panels coexist)
    // Panel width: desktop 520 (long prompt/option text reads on one screen instead of wrapping cramped at 360); small screens auto-shrink to visible width - 24 (physical adaptation is decided uniformly by placePhysPanel)
    function reflowPanel() {
      var w = Math.min(520, Math.round(getPhysViewport().w) - 24);
      placePhysPanel(dialog, { visW: w, dock: 'bottom', gap: 12, offsetY: 64, minH: 40, maxWidth: w + 'px', overflowY: 'auto' });
    }
    var dialog = el('div', { class: 'dbg-pick-dialog' }); // floating panel (bottom-right, does not cover the whole screen)
    var head = el('div', { class: 'dbg-pick-head' });
    var kindTitle = { confirm: t('🤖 AI needs your confirmation'), choose: t('🤖 AI asks you to choose'), input: t('✍️ AI asks for your input'), presence: t('🙋 AI asks if you\'re present') };
    head.appendChild(el('span', { class: 'dbg-pick-title' }, [kindTitle[kind] || t('🤖 AI needs your answer')]));
    var askSrc = ctx.agentSrcInfoBtn(it); // ⓘ: full source block toggled in the body (head space is tight)
    if (askSrc) {
      head.appendChild(askSrc);
      askSrc.addEventListener('click', function (e) {
        e.stopPropagation();
        ctx.toggleAgentSrcInfo(askSrc, body, function () {
          // reflow with the same placement params as the initial panel
          try { placePhysPanel(dialog, { visW: Math.min(420, Math.round(getPhysViewport().w) - 24), dock: 'bottom', gap: 12, offsetY: 64, minH: 40, maxWidth: '420px', overflowY: 'auto' }); } catch (e2) {}
          try { ctx.dodgeToolbarAboveDialog(dialog); } catch (e2) {}
        });
      });
    }
    var noTimeout = !(timeoutMs > 0); // wait forever: no countdown/pause (⏸ hidden), static ♾ in the header marks the panel persistent until the user acts
    var timerSpan = el('span', { style: 'font-weight:400;color:#93c5fd;font-size:11px' }, [noTimeout ? t('♾ Waiting') : ('⏱ ' + Math.ceil(timeoutMs / 1000) + 's')]);
    var pauseBtn = el('button', { title: t('Pause countdown') }, ['⏸']);
    if (noTimeout) pauseBtn.style.display = 'none';
    var minBtn = el('button', { title: t('Temporarily hide (click to restore)') }, [t('👁 Hide')]);
    head.appendChild(timerSpan);
    head.appendChild(pauseBtn);
    head.appendChild(minBtn);
    // One-click copy-all in the header (same interaction as the notify card): lucide copy icon -> green check.
    // Copies the full prompt (long URLs/auth links are painful to hand-select); body stays plain/selectable.
    var copyBtn = el('button', { title: t('Copy all'), style: 'padding:3px 7px' }, [elSvg(LUCIDE.copy, 13)]);
    copyBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var done = function (ok) {
        copyBtn.innerHTML = '';
        copyBtn.appendChild(ok ? elSvg(LUCIDE.check, 13) : document.createTextNode('✕'));
        copyBtn.style.color = ok ? '#4ade80' : '#f87171';
        setTimeout(function () {
          copyBtn.innerHTML = '';
          copyBtn.appendChild(elSvg(LUCIDE.copy, 13));
          copyBtn.style.color = '';
        }, 1200);
      };
      if (ctx.copyToClipboard) ctx.copyToClipboard(it.prompt || '', done); else done(false);
    });
    head.appendChild(copyBtn);
    // Cancel (decline this request): ✕ at the top-right of the panel header (standard close position); multi-select additionally has "✕ Cancel + ✅ Send selected" at the bottom (user-approved, kept)
    var cancelHead = el('button', { title: t('Cancel (decline this request)'), style: 'font-size:15px;font-weight:700;padding:2px 10px' }, ['✕']);
    cancelHead.addEventListener('click', function () { finishAsk({ status: 'rejected', reason: t('User cancelled') }); });
    head.appendChild(cancelHead);
    dialog.appendChild(head);
    var body = el('div', { class: 'dbg-pick-body' });
    // Prompt area: large font, high contrast + left accent bar (.dbg-ask-prompt) — the AI's question is the panel's most important content.
    // Plain selectable text; one-click copy-all lives in the header (lucide copy, same as the notify card)
    var promptBlock = el('div', { class: 'dbg-ask-prompt dbg-copyable' });
    promptBlock.appendChild(el('span', {}, [it.prompt || '']));
    body.appendChild(promptBlock);
    minBtn.addEventListener('click', function () {
      var hidden = body.style.display === 'none';
      body.style.display = hidden ? '' : 'none';
      minBtn.textContent = hidden ? t('👁 Hide') : t('👁 Show');
      // Recompute panel height: when hidden, collapse to a thin header bar (previously fixed height → body hidden but height unchanged = an empty box, quite comical); restore content height when shown
      try { reflowPanel(); } catch (e) {}
    });
    var ctl = el('div', { style: 'display:flex;flex-direction:column;gap:6px;margin-top:8px' });
    var multiple = !!it.multiple; // choose supports multi-select
    var singleShot = !(kind === 'choose' && multiple); // single-select: clicking an option answers immediately; multi-select/custom: two steps (pick, then click Send)
    // Options-area label (shown when kind is not input) — copy guides per interaction mode (numbered badges + keyboard 1-9 shortcuts)
    if (kind !== 'input') {
      ctl.appendChild(el('div', { class: 'dbg-ask-label' }, [singleShot ? t('Click an option or press 1-9 to answer:') : t('Check items (multi-select) then press Send:')]));
    }
    var optWrap = el('div', { style: 'display:flex;flex-direction:column;gap:8px;margin-top:8px' }); // vertical full-width list: long text is not squeezed and scans fast
    var sel = { v: null, idxs: {}, custom: false };
    // finishAskCustom hoisted to function level: it was declared inside the else block — block-level function declarations are scoped to their block in ESM/strict mode,
    // so the bottom multi-select "Send selected ✓" (outside the else block) referencing it → ReferenceError → multi-select panel construction aborts and never pops up
    function finishAskCustom() {
      var comment = commentInp ? commentInp.value.trim() : '';
      var cv = comment ? { comment: comment } : {};
      // The fixed "None of these" option → custom answer (the extra-note field is always available, regardless of whether this option is picked)
      if (sel.custom) {
        if (kind === 'choose') finishAsk({ status: 'answered', value: { index: -1, label: comment || t('None of these'), custom: true } });
        else if (kind === 'confirm') finishAsk({ status: 'answered', value: { approved: null, custom: comment || t('None of these') } });
        else finishAsk({ status: 'answered', value: { present: null, custom: comment || t('None of these') } });
        return;
      }
      if (kind === 'choose') {
        var choices2 = (it.choices && it.choices.length) ? it.choices : [];
        if (multiple) {
          var idxs = Object.keys(sel.idxs).map(Number).sort(function (a, b) { return a - b; });
          if (!idxs.length && !comment) return;
          if (!idxs.length) finishAsk({ status: 'answered', value: { indexes: [], custom: comment } });
          else finishAsk({ status: 'answered', value: Object.assign({ indexes: idxs, labels: idxs.map(function (i) { return choices2[i] != null ? choices2[i] : String(i); }) }, cv) });
        } else {
          if (sel.v === null && !comment) return;
          if (sel.v === null) finishAsk({ status: 'answered', value: { index: -1, label: comment, custom: true } });
          else { var idx = parseInt(sel.v, 10); finishAsk({ status: 'answered', value: Object.assign({ index: idx, label: choices2[idx] != null ? choices2[idx] : sel.v }, cv) }); }
        }
      } else if (kind === 'confirm') {
        if (sel.v === null && !comment) return;
        if (sel.v === null) finishAsk({ status: 'answered', value: { approved: null, custom: comment } });
        else finishAsk({ status: 'answered', value: Object.assign({ approved: sel.v === 'yes' }, cv) });
      } else if (kind === 'presence') {
        if (sel.v === null && !comment) return;
        if (sel.v === null) finishAsk({ status: 'answered', value: { present: null, custom: comment } });
        else if (sel.v === 'later') finishAsk({ status: 'rejected', reason: t('User temporarily away'), ...cv });
        else finishAsk({ status: 'answered', value: Object.assign({ present: true }, cv) });
      }
    }
    // Option button order contract (user-specified, 2026-09): numbered options 1/2/3… → Confirm (primary action) → Cancel/Negative → "None of these" (top to bottom)
    function askNum(n) { return el('span', { class: 'dbg-ask-num' }, [String(n)]); }
    if (kind === 'confirm') {
      optWrap.appendChild(el('button', { class: 'dbg-primary dbg-ask-opt', 'data-v': 'yes' }, [askNum(1), t('Yes / Confirm')]));
      optWrap.appendChild(el('button', { class: 'dbg-ghost dbg-ask-opt dbg-ask-no', 'data-v': 'no' }, [askNum(2), t('No / Cancel')]));
      optWrap.appendChild(el('button', { class: 'dbg-ghost dbg-ask-opt dbg-ask-opt-custom', 'data-custom': '1' }, [askNum(3), t('None of these (type an answer)')]));
    } else if (kind === 'choose') {
      var choices = (it.choices && it.choices.length) ? it.choices : [t('Option A'), t('Option B')];
      choices.forEach(function (c, i) { optWrap.appendChild(el('button', { class: 'dbg-ghost dbg-ask-opt', 'data-i': String(i) }, [askNum(i + 1), String(c)])); });
      optWrap.appendChild(el('button', { class: 'dbg-ghost dbg-ask-opt dbg-ask-opt-custom', 'data-custom': '1' }, [askNum(choices.length + 1), t('None of these work (type an answer)')]));
    } else if (kind === 'presence') {
      optWrap.appendChild(el('button', { class: 'dbg-primary dbg-ask-opt', 'data-v': 'yes' }, [askNum(1), t('I\'m here, continue')]));
      optWrap.appendChild(el('button', { class: 'dbg-ghost dbg-ask-opt dbg-ask-no', 'data-v': 'later' }, [askNum(2), t('Later / Away')]));
    }
    if (kind !== 'input') ctl.appendChild(optWrap);
    // Standalone extra note (confirm/choose/presence): can be added after picking any option; filling only the note = custom answer
    var commentInp = null, sendBtn = null;
    if (kind === 'confirm' || kind === 'choose' || kind === 'presence') {
      ctl.appendChild(el('div', { class: 'dbg-ask-label' }, [t('📝 Extra note (optional)')]));
      var commentRow = el('div', { style: 'display:flex;gap:6px' });
      commentInp = el('input', { type: 'text', placeholder: singleShot ? t('📝 Extra note (optional; added when you click an option)') : t('📝 Extra note (optional)'), style: 'background:rgba(255,255,255,.06);border:1px solid rgba(148,163,184,.35);color:#f1f5f9;border-radius:8px;padding:9px 11px;font:inherit;flex:1' });
      // Send button: bright green highlight (CSS .dbg-ask-send) — widened and bolded (user testing: "the confirm button is obvious but Send is not obvious at all");
      // hidden by default for single-shot answering (clicking an option already sends); appears only for "None of these" (which requires typing);
      // multi-select: the send button merges into the bottom action row (footSend) — not created here, avoiding two "Send selected ✓" buttons
      sendBtn = multiple ? null : el('button', { class: 'dbg-primary dbg-ask-send', style: (singleShot ? 'display:none;' : '') + 'flex:1;font-weight:700;font-size:13px;padding:9px 12px' }, [t('✓ Send')]);
      commentRow.appendChild(commentInp);
      if (sendBtn) commentRow.appendChild(sendBtn);
      ctl.appendChild(commentRow);
    }
    if (kind === 'input') {
      var inp = el('input', { type: 'text', value: it.defaultValue || '', placeholder: t('Type your answer…'), style: 'background:rgba(255,255,255,.06);border:1px solid rgba(148,163,184,.35);color:#f1f5f9;border-radius:8px;padding:9px 11px;font:inherit;flex:1' });
      var send = el('button', { class: 'dbg-primary dbg-ask-send' }, [t('Send')]);
      var r3 = el('div', { style: 'display:flex;gap:6px' });
      r3.appendChild(inp); r3.appendChild(send);
      ctl.appendChild(r3);
      send.addEventListener('click', function () { finishAsk({ status: 'answered', value: { text: inp.value } }); });
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') send.click(); });
    } else {
      // Options (single/multi-select) + extra note sent together
      var optBtns = optWrap.querySelectorAll('.dbg-ask-opt');
      function refreshAskSend() {
        var hasSel = sel.custom || (multiple ? Object.keys(sel.idxs).length > 0 : sel.v !== null);
        var hasCmt = !!(commentInp && commentInp.value.trim());
        if (sendBtn) sendBtn.disabled = !(hasSel || hasCmt);
        if (footSend) {
          footSend.disabled = !(hasSel || hasCmt);
          if (multiple) footSend.textContent = t('✅ Send selected (') + Object.keys(sel.idxs).length + '）';
        }
      }
      Array.prototype.forEach.call(optBtns, function (o) {
        o.addEventListener('click', function () {
          // Fixed "None of these" option: one of the regular options (exclusive); picking it focuses the extra-note input (the extra note itself is always available)
          if (o.hasAttribute('data-custom')) {
            sel.custom = true;
            sel.v = null; sel.idxs = {};
            Array.prototype.forEach.call(optBtns, function (x) { x.classList.toggle('dbg-on', x === o); });
            if (sendBtn) sendBtn.style.display = ''; // "None of these" requires typing → show the send button (hidden by default in single-shot mode)
            if (commentInp) { try { commentInp.focus(); } catch (e) {} }
            refreshAskSend();
            return;
          }
          sel.custom = false;
          var customBtn = optWrap.querySelector('.dbg-ask-opt-custom');
          if (customBtn) customBtn.classList.remove('dbg-on');
          if (kind === 'choose' && multiple) {
            var i = o.getAttribute('data-i');
            if (sel.idxs[i]) { delete sel.idxs[i]; o.classList.remove('dbg-on'); }
            else { sel.idxs[i] = true; o.classList.add('dbg-on'); }
          } else {
            var ov = o.getAttribute('data-i') !== null ? o.getAttribute('data-i') : o.getAttribute('data-v');
            sel.v = ov;
            Array.prototype.forEach.call(optBtns, function (x) { x.classList.toggle('dbg-on', x === o); });
          }
          refreshAskSend();
          // Single-shot answering: confirm/presence/choose (single) answers immediately when an option is clicked (any typed extra note rides along with the answer) —
          // it used to be two steps (pick, then click Send): users clicked ✅, saw no reaction and assumed it was broken (user testing: "clicked but nothing happened");
          // multi-select (requires combined checking) and "None of these" (requires typing) remain two steps — their ✓ send button does not disappear
          if (!(kind === 'choose' && multiple)) {
            setTimeout(finishAskCustom, 0);
          }
        });
      });
      if (sendBtn) sendBtn.addEventListener('click', finishAskCustom);
      if (commentInp) {
        commentInp.addEventListener('input', refreshAskSend);
        commentInp.addEventListener('keydown', function (e) {
          if (e.key !== 'Enter') return;
          if (sendBtn && !sendBtn.disabled) sendBtn.click();
          else if (footSend) footSend.click(); // multi-select: Enter triggers the bottom "Send selected ✓" (footSend is a hoisted var, assigned by the time of the click)
        });
      }
      refreshAskSend();
    }
    body.appendChild(ctl);
    if (it.rejectable !== false && kind !== 'presence') {
      var det2 = el('details', {}, []);
      // Reject area: enlarged text/click target (user testing: 11px was too small to tap)
      det2.appendChild(el('summary', { style: 'cursor:pointer;font-size:13px;color:#cbd5e1;margin-top:10px;padding:4px 0;user-select:none' }, [t('✕ Can\'t handle now (tell AI why)')]));
      var rr2 = el('div', { style: 'display:flex;flex-wrap:wrap;gap:8px;margin-top:6px' });
      [t('I can\'t fulfill this right now'), t('Can\'t find/select it right now'), t('Handle it later')].forEach(function (r) {
        rr2.appendChild(el('button', { class: 'dbg-ask-reject', 'data-reason': r }, [r]));
      });
      det2.appendChild(rr2);
      body.appendChild(det2);
      // Recompute panel height when the "can't handle now" section expands/collapses: placePhysPanel fixes the height at creation based on the collapsed state,
      // after expanding the content grows taller → the fixed height overflows with a scrollbar (user-tested); reposition after toggle (bottom-anchored → grows upward)
      det2.addEventListener('toggle', function () {
        try { reflowPanel(); } catch (e) {}
      });
    }
    dialog.appendChild(body);
    // Bottom action row: multi-select only (user-approved: Cancel on the left + Send on the right); cancel for single-select/confirm/input has moved to the header ✕
    if (kind === 'choose' && multiple) {
      var footRow = el('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:10px' });
      footRow.appendChild(el('button', { class: 'dbg-pick-cancel dbg-ask-cancel' }, [t('✕ Cancel')]));
      // Bottom primary send button: bigger and more prominent (✅ + live selected count + disabled when nothing is selected) — user testing: the original two "Send selected ✓" buttons were duplicated and hard to read
      var footSend = el('button', { class: 'dbg-primary dbg-ask-send', style: 'flex:1;font-weight:800;font-size:16px;padding:12px 18px;border-radius:10px;letter-spacing:.5px;display:flex;align-items:center;justify-content:center;gap:6px' }, [t('✅ Send selected (0)')]);
      footSend.disabled = true; // nothing checked initially: disabled (refreshAskSend runs first inside the else block while footSend is still unassigned, so initialize explicitly after creation)
      footSend.addEventListener('click', finishAskCustom);
      footRow.appendChild(footSend);
      body.appendChild(footRow);
    }
    ctx.root.appendChild(dialog);
    dialog.style.zIndex = '2147483648'; // cover the toolbar (2147483647) — same as above, keeps the buttons clickable
    // Shared floating-layer positioning (placePhysPanel — same algorithm as the AI window/HUD/confirm dialog): bottom-centered, width capped at 520/auto-shrunk on small screens, content-fit height, ≤ visible area
    // offsetY: lift the bottom to leave clearance (with the "can't handle now" reject area expanded or in multi-select the panel grows upward, keeping the bottom clear of the AI window/FAB)
    try { reflowPanel(); } catch (e) {}
    try { ctx.dodgeToolbarAboveDialog(dialog); } catch (e) {} // toolbar already shown → dodge immediately (same as the pick confirm dialog)
    // Drag to move: hold the header (non-button) to drag the panel — shared gesture makePointerDrag (same infrastructure as the AI window/fab, drag.js)
    try {
      makePointerDrag({
        handle: head, capture: 'now', raf: true, preventStart: true,
        filter: function (e) { return !(e.target && e.target.closest && e.target.closest('button')); }, // header buttons (⏸/👁/✕) do not trigger dragging
        onStart: function () {
          dialog.classList.add('dbg-dragging');
          return { left: dialog.offsetLeft || 0, top: dialog.offsetTop || 0 };
        },
        onMove: function (ev, st, dx, dy) {
          // left/top are CSS px (same coordinate system as positionPhysical); clamped to the viewport
          var nl = Math.min(Math.max(0, st.left + dx), Math.max(40, (window.innerWidth || 0) - 60));
          var nt = Math.min(Math.max(0, st.top + dy), Math.max(24, (window.innerHeight || 0) - 40));
          dialog.style.left = nl + 'px';
          dialog.style.top = nt + 'px';
          dialog.style.right = 'auto';
          dialog.style.bottom = 'auto';
        },
        onEnd: function () { dialog.classList.remove('dbg-dragging'); },
      });
    } catch (e) {}

    var done = false;
    function finishAsk(res) {
      if (done) return;
      done = true;
      delete ctx.hostAskPanels[requestId];
      clearInterval(timer);
      document.removeEventListener('keydown', keyHandler);
      res.tookMs = Date.now() - startedAt;
      dialog.classList.remove('dbg-open');
      setTimeout(function () { if (dialog.parentNode) dialog.parentNode.removeChild(dialog); }, 200);
      try { ctx.floatToolbarReAnchor(); } catch (e) {} // floating window closed → the toolbar re-anchors next to the selection (it was moved aside to dodge the floating window when the panel popped up)
      if (silent) return; // already settled server-side (timeout/cancel/agent stop) — just close the panel, no bridge return
      if (it.async) {
        // Async: success/decline messages go to MCP via bridge events (non-blocking — the bridge already returned async); answered results also enter the AI pending area (candidate [answer N] — consistent with the HUD)
        if (res.status === 'answered') {
          var txt = describeAnswer(kind, res.value);
          ctx.postBridgeEvent('user_answer', { kind: kind, answer: txt, status: 'answered' });
          ctx.addMsg('sys', t('💬 User answered: ') + txt + t('(async — placed in AI pending area, click [answer N] to send)'));
        } else {
          ctx.postBridgeEvent('user_answer', { kind: kind, answer: res.status === 'rejected' ? t('❌ Denied: ') + (res.reason || '') : t('⏱ Timeout'), status: res.status === 'rejected' ? 'rejected' : 'timeout', reason: res.reason || '' });
          ctx.addMsg('sys', res.status === 'rejected' ? t('✕ User denied: ') + (res.reason || '') + t('(async — MCP notified)') : t('⏱ Wait timeout (no user response)'));
        }
        return;
      }
      ctx.sendInteractionResult(requestId, res);
      ctx.addMsg('sys', res.status === 'answered' ? t('💬 User answered (sent to AI)') : (res.status === 'rejected' ? t('✕ User denied: ') + (res.reason || '') : t('⏱ Wait timeout (no user response)')));
    }
    ctx.hostAskPanels = ctx.hostAskPanels || {};
    var silent = false;
    ctx.hostAskPanels[requestId] = { finishAsk: finishAsk, startedAt: startedAt };
    var timer = noTimeout ? null : setInterval(tickCountdown, 500); // wait forever has no timer (finishAsk clearInterval(null) is safe)
    // Countdown (pausable/resumable: after ⏸ the server pauses its timer in sync, giving the user ample time to handle it) — exists only when the AI passed a timeout
    var deadline = Date.now() + timeoutMs;
    var paused = false;
    var remainingMs = timeoutMs; // freeze remaining time while paused; rebuild the deadline from it on resume (the original logic reused the stale deadline, losing the paused duration → the number jumped after resume)
    function tickCountdown() {
      if (paused) return;
      var left = Math.max(0, deadline - Date.now());
      timerSpan.textContent = '⏱ ' + Math.ceil(left / 1000) + 's';
      if (left <= 0) finishAsk({ status: 'timeout', error: t('No user response (away)') });
    }
    if (!noTimeout) pauseBtn.addEventListener('click', function () {
      paused = !paused;
      if (paused) {
        remainingMs = Math.max(0, deadline - Date.now());
        timerSpan.textContent = t('⏸ Paused (') + Math.ceil(remainingMs / 1000) + 's）';
        pauseBtn.textContent = t('▶ Resume');
      } else {
        deadline = Date.now() + remainingMs;
        timerSpan.textContent = '⏱ ' + Math.ceil(remainingMs / 1000) + 's';
        pauseBtn.textContent = t('⏸ Pause');
      }
      ctx.sendInteractionControl(requestId, paused ? 'pause' : 'resume');
    });
    // Keyboard shortcuts: number keys 1-9 directly pick the matching option (matching the badge numbers; ignored while an input is focused — typing takes priority); only the newest panel responds (prevents double responses when multiple panels coexist)
    var keyHandler = function (e) {
      if (done) return;
      if (seq !== ctx.askPanelSeq) return;
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      var n = parseInt(e.key, 10);
      if (!(n >= 1) || n > 9) return;
      var btns = optWrap.querySelectorAll('.dbg-ask-opt');
      if (btns[n - 1]) { btns[n - 1].click(); e.preventDefault(); }
    };
    document.addEventListener('keydown', keyHandler);
    dialog.addEventListener('click', function (e) {
      var t = e.target.closest('button');
      if (!t) return;
      if (t.classList.contains('dbg-ask-yes')) {
        finishAsk(kind === 'confirm' ? { status: 'answered', value: { approved: true } } : { status: 'answered', value: { present: true } });
      } else if (t.classList.contains('dbg-ask-no')) {
        finishAsk(kind === 'confirm' ? { status: 'answered', value: { approved: false } } : { status: 'rejected', reason: t('User temporarily away') });
      } else if (t.classList.contains('dbg-ask-choice')) {
        var i = parseInt(t.getAttribute('data-i'), 10);
        var ch = it.choices || [];
        finishAsk({ status: 'answered', value: { index: i, label: ch[i] != null ? ch[i] : String(i) } });
      } else if (t.classList.contains('dbg-ask-reject')) {
        finishAsk({ status: 'rejected', reason: t.getAttribute('data-reason') });
      } else if (t.classList.contains('dbg-ask-cancel')) {
        finishAsk({ status: 'rejected', reason: t('User cancelled') });
      }
    });
    // Server-side settlement (agent stop/cancel) → silently close the Q&A panel (no bridge return — the bridge already settled; sending back would report "no pending")
    ctx.closeHostAskPanel = function (requestId) {
      var p = ctx.hostAskPanels[requestId];
      if (p) { silent = true; p.finishAsk({ status: 'cancelled', error: t('AI stopped') }); }
    };
  };

  // ---- Pure notification card (user_notify): small floating card at the bottom-right — visible and reviewable in-page beyond the system Notification ----
  // No answer needed / no bridge return (notify is fire-and-forget): timeout optional — omitted = persistent until ✕ (♾ no countdown, no auto-close); if passed, a countdown runs and the card auto-closes on expiry (⏸ pausable)
  // Multi-card stacking: active-card stack -- new cards pile upward instead of stacking on the same spot
  //   (historical bug: every card docked at one point, persistent cards piled up with only the top visible);
  //   closing/expiring a card re-stacks the rest; user-dragged cards keep their position (restack skips them);
  //   stack capped at 6, oldest card auto-closed beyond that.
  ctx.notifyCards = [];
  function restackNotifyCards() {
    var offsetY = 64; // bottom baseline (same clearance as fab/answer cards)
    for (var i = 0; i < ctx.notifyCards.length; i++) {
      var c = ctx.notifyCards[i];
      if (!c.dialog.isConnected || c.userMoved) continue;
      try {
        var r = placePhysPanel(c.dialog, { visW: c.visW, dock: 'bottom', gap: 12, offsetY: offsetY, minH: 40, maxWidth: '520px', overflowY: 'auto' });
        c.visH = r.visH;
        offsetY += r.visH + 12;
      } catch (e) {}
    }
  }
  ctx.showNotifyPanel = function (requestId, it) {
    var timeoutMs = parseInt(it.timeoutMs, 10) > 0 ? parseInt(it.timeoutMs, 10) : 0; // timeout optional: only >0 runs the countdown/auto-closes on expiry; 0 = persistent until the user clicks ✕
    var dialog = el('div', { class: 'dbg-pick-dialog' });
    var head = el('div', { class: 'dbg-pick-head' });
    head.appendChild(el('span', { class: 'dbg-pick-title' }, ['🔔 ' + (it.title || t('AI notification'))]));
    var notifSrc = ctx.agentSrcInfoBtn(it); // ⓘ: source block toggled in the card body
    if (notifSrc) {
      head.appendChild(notifSrc);
      notifSrc.addEventListener('click', function (e) { e.stopPropagation(); ctx.toggleAgentSrcInfo(notifSrc, body, function () { try { restackNotifyCards(); } catch (e2) {} }); });
    }
    var noTimeout = !(timeoutMs > 0); // no timeout: the notification card is persistent (♾ no countdown, no auto-close)
    var timerSpan = el('span', { style: 'font-weight:400;color:#93c5fd;font-size:11px' }, [noTimeout ? t('♾ Persistent') : ('⏱ ' + Math.ceil(timeoutMs / 1000) + 's')]);
    var pauseBtn = el('button', { title: t('Pause countdown') }, ['⏸']);
    if (noTimeout) pauseBtn.style.display = 'none';
    head.appendChild(timerSpan);
    head.appendChild(pauseBtn);
    // one-click copy-all lives in the header (the floating body-corner button moved up here: body stays
    // clean and freely selectable); icon is the lucide copy line icon (same shapes as the host message
    // copy button -- the color emoji clashed), success feedback swaps to a green check
    var copyBtn = el('button', { title: t('Copy all'), style: 'padding:3px 7px' }, [elSvg(LUCIDE.copy, 13)]);
    copyBtn.addEventListener('click', function (e) {
      e.stopPropagation(); // keep panel-level click delegation out
      var done = function (ok) {
        copyBtn.innerHTML = '';
        copyBtn.appendChild(ok ? elSvg(LUCIDE.check, 13) : document.createTextNode('✕'));
        copyBtn.style.color = ok ? '#4ade80' : '#f87171';
        setTimeout(function () {
          copyBtn.innerHTML = '';
          copyBtn.appendChild(elSvg(LUCIDE.copy, 13));
          copyBtn.style.color = '';
        }, 1200);
      };
      if (ctx.copyToClipboard) ctx.copyToClipboard(it.body || '', done); else done(false);
    });
    head.appendChild(copyBtn);
    var closeBtn = el('button', { title: t('Close'), style: 'font-size:15px;font-weight:700;padding:2px 10px' }, ['✕']);
    head.appendChild(closeBtn);
    dialog.appendChild(head);
    var body = el('div', { class: 'dbg-pick-body dbg-notify-body' });
    body.appendChild(el('span', {}, [it.body || ''])); // plain-text body: freely selectable / Ctrl+C / context-menu copy (CSS .dbg-notify-body user-select:text)
    dialog.appendChild(body);
    var visW = Math.min(520, Math.round(getPhysViewport().w) - 24);
    var card = { dialog: dialog, visW: visW, visH: 0, userMoved: false, close: function () { closeCard(); } }; // stack entry (closeCard declared later, defined by call time)
    try {
      makePointerDrag({
        handle: head, capture: 'now', raf: true, preventStart: true,
        filter: function (e) { return !(e.target && e.target.closest && e.target.closest('button')); },
        onStart: function () { dialog.classList.add('dbg-dragging'); return { left: dialog.offsetLeft || 0, top: dialog.offsetTop || 0 }; },
        onMove: function (ev, st, dx, dy) {
          card.userMoved = true; // user-dragged card keeps its placement: restack skips it
          dialog.style.left = Math.min(Math.max(0, st.left + dx), Math.max(40, (window.innerWidth || 0) - 60)) + 'px';
          dialog.style.top = Math.min(Math.max(0, st.top + dy), Math.max(24, (window.innerHeight || 0) - 40)) + 'px';
          dialog.style.right = 'auto'; dialog.style.bottom = 'auto';
        },
        onEnd: function () { dialog.classList.remove('dbg-dragging'); },
      });
    } catch (e) {}
    var done = false;
    var closeCard = function () {
      if (done) return; done = true; clearInterval(timer);
      var i = ctx.notifyCards.indexOf(card); if (i >= 0) ctx.notifyCards.splice(i, 1);
      if (dialog.parentNode) dialog.parentNode.removeChild(dialog);
      restackNotifyCards(); // re-stack remaining cards to fill the gap
    };
    var deadline = Date.now() + timeoutMs, paused = false, remainingMs = timeoutMs; // pause freezes the remaining time, resume rebuilds the deadline (same as the Q&A panel)
    var timer = noTimeout ? null : setInterval(function () { // wait forever has no timer (closeCard clearInterval(null) is safe)
      if (paused) return;
      var left = Math.max(0, deadline - Date.now());
      timerSpan.textContent = '⏱ ' + Math.ceil(left / 1000) + 's';
      if (left <= 0) closeCard();
    }, 500);
    if (!noTimeout) pauseBtn.addEventListener('click', function () {
      paused = !paused;
      if (paused) {
        remainingMs = Math.max(0, deadline - Date.now());
        timerSpan.textContent = t('⏸ Paused (') + Math.ceil(remainingMs / 1000) + 's）';
        pauseBtn.textContent = t('▶ Resume');
      } else {
        deadline = Date.now() + remainingMs;
        timerSpan.textContent = '⏱ ' + Math.ceil(remainingMs / 1000) + 's';
        pauseBtn.textContent = t('⏸ Pause');
      }
    });
    closeBtn.addEventListener('click', closeCard);
    ctx.root.appendChild(dialog); // mount before positioning: placePhysPanel measures height from content; when unmounted scrollHeight=0 would measure the card at its minimum height
    ctx.notifyCards.push(card);
    while (ctx.notifyCards.length > 6) { // too many persistent cards would fill the screen -> auto-close the oldest (normal closeCard cleanup)
      var oldest = ctx.notifyCards[0];
      if (oldest && oldest.close && oldest.dialog.isConnected) oldest.close();
      else { ctx.notifyCards.shift(); if (oldest && oldest.dialog.parentNode) oldest.dialog.parentNode.removeChild(oldest.dialog); }
    }
    restackNotifyCards(); // unified stack layout (measures + positions the new card too)
  };

  // ---- MCP bridge interaction entry: notification + routing (pick_element → pick panel; Q&A → AI window/fallback panel) ----
  ctx.handleMcpInteraction = function (payload) {
    var it = payload && payload.interaction ? payload.interaction : {};
    var itKind = it.kind || 'confirm';
    // Pure notification (user_notify): only pop the browser notification, do not render the Q&A panel — notify has no prompt/no options,
    // and going through the Q&A panel would pop an absurd empty card saying "click an option to answer instantly" with not a single option (historical bug: a notification rendered as Q&A)
    if (itKind === 'notify') {
      // Dual-channel dedup: with the standalone bridge, both paths — bridge direct-to-page and AI window relay — can reach the launcher → pop only once (the Q&A panel dedups by requestId inside showHostAskPanel; the notification path has no panel, so dedup here)
      if (ctx.lastNotifyId === payload.requestId) return;
      ctx.lastNotifyId = payload.requestId;
      // noToastFallback: the persistent notify card below already presents the content in-page --
      // the toast fallback would duplicate it at the same dock spot (small-screen report: toast on top of the card)
      ctx.notifyUser(it.title || t('🤖 AI has a message'), it.body || '', { noToastFallback: true });
      ctx.showNotifyPanel(payload.requestId, it); // in-page notification card: draggable and reviewable (timeout optional: omitted = persistent until ✕; the system notification auto-dismisses)
      return;
    }
    // Browser notification (Notification + title flashing + attention beep): tell the user a message needs handling;
    // body prefixed with the agent session source (plain text — Notification has no rich formatting)
    var _src = ctx.formatAgentSrc(it);
    var _promptBody = itKind === 'pick_element' ? (it.prompt || t('Please click an element on the page')) : (it.prompt || t('Please answer on the page'));
    ctx.notifyUser(t('🤖 AI needs you'), (_src ? '[' + _src.text + '] ' : '') + _promptBody);
    if (itKind === 'pick_element') {
      ctx.showPickElementPanel(payload.requestId, it); // collapse the AI window + enter pick mode + pop the panel (✓/✕/timeout returned to the bridge)
    } else {
      // Current AI window = pi-web direct embed (the aiti extension has no answer-card renderer) — confirm/choose/input/presence always go through the host fallback Q&A panel
      ctx.showHostAskPanel(payload.requestId, it);
    }
  };
}
