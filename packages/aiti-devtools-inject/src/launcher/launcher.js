/**
 * launcher.js — in-page AI debug assistant · host entry (split from dbg-launcher.js, phase A+B: closure + pure extraction)
 */
import { VERSION, DEFAULTS } from './config.js';
import { el, elSvg, LUCIDE, ensureStyles } from './dom.js';
import { MINI_DBG_CLIENT } from 'virtual:dbg-client';
import { getPhysViewport, detectCoordSemantics, _fixedVisual, positionPhysical, visToCss, capVisW, capVisH, placePhysBox, getPhysScreen, isMobileUA, detectScreenMode, isSmallScreen, isTouchCompact, isTouchDevice } from './viewport.js';
import { DANGER_COMMANDS, GESTURE_COMMANDS, HOST_NAV_KEYS, AI_WIN_DEFAULTS, DBG_STATE_KEY, OPT_KEY, AI_WIN_KEY, DBG_SHOW_KEY, PROFILES_KEY, DEFAULT_RELEASE_KEY } from './constants.js';
import { lsGetJSON, lsSetJSON, lsGetString, lsSetString } from './storage.js';
import { makePointerDrag } from './drag.js';
import { dbgMsg } from './protocol.js';
import { initState } from './state.js';
import { initFab } from './fab.js';
import { initNav } from './nav.js';
import { initTarget } from './target.js';
import { initHelp } from './help.js';
import { initOptions } from './options.js';
import { initDanger } from './danger.js';
import { initInteract } from './interact.js';
import { initProfiles } from './profiles.js';
import { initHud } from './hud.js';
import { initToolbar } from './toolbar.js';
import { initInject } from './inject.js';
import { initAiwin } from './aiwin.js';
import { initRouting } from './routing.js';
import { initInspector } from './inspector.js';
import { initDialog } from './dialog.js';
import { initPicks } from './picks.js';
import { initDebug } from './debug.js';
import { t } from './i18n.js';

// AI window feature detection (anti-nesting): popup same-name window / _dbg URL param (aiwin-specific param when composing the AI window URL) /
// shared library marker object __AITI_AI_WIN__ (aiti-client sets it at top level after judging "AI window identity" — only set when it has the _dbg/popup name,
// ordinary pi-web pages don't set it so there are no false kills; falls back when the override param gets cleaned/duplicated).
// Note: do not use AitiHostProtocol — it loads on all pi-web pages and would falsely kill the launcher on ordinary pages.
function aiWindowMarkers() {
  try {
    return window.name === 'aiti-ai-popup'
      || /[?&]_dbg=/.test(location.search)
      || /[?&]_dbg=/.test(location.hash)
      || !!window.__AITI_AI_WIN__;
  } catch (e) { return false; }
}

export function createDbgLauncher(url, opts) {
  // Anti-nesting: if this page is already an aiti AI window → do not start the launcher.
  // Otherwise AI windows would pre-create more AI windows, nesting layer by layer (dev ai inside prod ai…); same-site iframes share the renderer main thread,
  // and a few layers in, the main thread is dragged to death — the debugged page freezes outright (reproduces after a few refreshes).
  // Markers (any one hit counts):
  //   ① window.name = aiti-ai-popup (popup mode, same-name window from openAiPopup)
  //   ② URL carries _dbg= (aiwin-specific param when composing the AI window URL; business pages won't hit it by chance)
  //   ③ shared library marker object: window.__AITI_AI_WIN__ (aiti-client sets it at top level after judging "AI window identity" —
  //       only set when it has the _dbg/popup name, ordinary pi-web pages don't set it so there are no false kills; falls back when the override param gets cleaned/duplicated)
  try {
    if (aiWindowMarkers()) {
      if (window.console && console.info) console.info('[aiti] 检测到 AI 窗特征（popup 名/_dbg 参数/共享库对象）——不加载 launcher（防嵌套）');
      return null;
    }
  } catch (e) {}
  // ---- Shared ctx (all closure variables/functions live on ctx; Phase A registration = original function declaration hoisting) ----
  const ctx = {};
  ctx.url = url;
  initState(ctx);
  initFab(ctx);
  initNav(ctx);
  initTarget(ctx);
  initOptions(ctx);
  initDanger(ctx);
  initInteract(ctx);
  initProfiles(ctx);
  initHud(ctx);
  initToolbar(ctx);
  initHelp(ctx); // ❓ help window (the first hostKey tier depends on helpDialogOpen/closeHelpDialog; consuming events before routing/inspector suffices)
  initInject(ctx);
  initAiwin(ctx);
  initRouting(ctx);
  initInspector(ctx);
  initDialog(ctx);
  initPicks(ctx);
  initDebug(ctx);
  // ---- Phase B: run initialization statements in the original order (var→ctx assignment / DOM creation / event binding / top-level calls) ----
    // Idempotent: one inject has only one launcher (one Inspector button); repeated calls return the existing instance
  ctx.existingLauncher = window.document && document.getElementById('__dbg_launcher');
    if (ctx.existingLauncher && ctx.existingLauncher.__dbgLauncher) return ctx.existingLauncher.__dbgLauncher;
  ctx.cfg = Object.assign({}, DEFAULTS, opts || {});
  // Self host page (opts.selfHostPage, decided by the standalone injection entry when "launcher same-origin with the page + pi-web app page"):
  // no pre-creating/restoring of the AI window, hide the 💬 button, exiting pick doesn't bounce back to the AI window — the page itself is the AI window; the top InspectButton
  // plus the in-page pick loop already suffice. Cross-instance launchers (same-origin check fails) don't enter this mode; original behavior is kept.
  ctx.selfHostPage = !!(opts && opts.selfHostPage);
  ctx.iframeObservers = []; // keep all observers for destroy to disconnect (must be assigned before watchIframes is called)
    // Phase 3: url is optional (target = host + host's real iframes; url kept only as a legacy parameter)

    ensureStyles(ctx.cfg.accent);

    // ---- launcher state persistence: auto-restore after refresh (HMR full reload / manual F5) (AI window/position/profile/viewport etc.) ----

  ctx.dbgState = ctx.loadDbgState();
  ctx.aiOpen = !!ctx.dbgState.aiOpen; // AI window was open before refresh → auto reopen after refresh (restore from memory)



  ctx.root = el('div', { id: '__dbg_launcher' });
    // Early mount: with a synchronous head script the body may not be ready — mount as soon as the body appears (not relying on page load, so the AI window appears ASAP)

    ctx.mountRoot(); // only handles early mount + injection; AI window restore happens at the end (after aiBtn is ready)
    // Note: the launcher does not handle bridge connection — all connections are owned by the AI window (the AI window connects as role=ai and operations are forwarded to the host via host-protocol);
    // page bridge connection is only triggered manually in the standalone-bridge scenario (panel 🔌 button → dbg_mcp_connect); the launcher does not auto-connect at startup

    // ---------------- Two floating buttons (only these are injected at first) ----------------
  ctx.fab = el('div', { class: 'dbg-fab' });
  ctx.aiBtn = el('button', { 'data-label': t('AI message') }, ['💬']);
  ctx.inspBtn = el('button', { 'data-label': 'Inspector' }, [elSvg(LUCIDE.crosshair, 15)]);
    ctx.fab.appendChild(ctx.aiBtn);
    ctx.fab.appendChild(ctx.inspBtn);
    // Self host page: 💬 (no AI window to open) and 🎯 (top toolbar already has the InspectButton) are both unneeded —
    // hide the whole FAB and keep only the top toolbar button (user request). Cross-instance launchers don't enter this mode; FAB stays as usual.
    if (ctx.selfHostPage) ctx.fab.style.display = 'none';
    // ---- fab drag with edge sliding (small-screen adaptation core): drag from a blank area, release snaps to the nearest edge; after snapping to an edge, keep dragging to slide along it ----
    // Snap rules: right=vertical sliding / bottom=horizontal sliding / left=vertical sliding / top=horizontal sliding; position persisted to localStorage (restored on refresh)
    // ---- Visual bounds + scale factor (visual px as the unified coordinate system): ----
    //   w/h = screen width/height (mobile without meta: layout=980 much wider than screen, use screen; desktop: window=innerWidth) — never changes with pinch
    //   scale = "screen/layout" normalization factor (layout coords ×scale = visual px; counter-zoom ÷scale converts back to layout)
    //   Key pitfall (iOS Safari/old WeChat kernel): visualViewport.scale may be missing or semantically reversed (reports "layout/screen" instead of "screen/layout"),
    //   and on meta-less pages innerWidth×scale ≠ screen width while pinching — snapped buttons fly off-screen or misalign inside it.
    //   Detection: vv.width×scale hitting screen width = forward; vv.width÷scale hitting screen width = reversed (take the reciprocal)

    // ---- clientX coordinate system detection: touch/mouse coords on real devices are visual screen coords (ppk/Chromium),
    //      but CDP emulation/some WebViews report layout coords — judge by the closeness of rect(layout) vs rect×scale(visual); the drag converts 1:1 by semantics to track the pointer ----

    // ---- position:fixed semantics: Chrome/Android/desktop are relative to the layout viewport (needs /scale + vv.offset compensation);
    //      iOS (Safari/Chrome/WeChat are all WebKit-based) fixed is relative to the visual viewport (left/width are direct visual values) —
    //      pure layout on iOS: fab left=845 layout treated as visual → off-screen (Inspect invisible), AI window width=927 overflows the screen (verified: invisible on small screens without zoom)----

    // ---- Unified physical pinning function: pin the element at visual screen (visX, visY) (unmoved by any zoom/scroll/pan)----
    //   Principle: position:fixed is relative to the layout viewport (moves with zoom) → the counter-zoom transform cancels the zoom;
    //   after pinch+pan the visual viewport is offset within layout (vv.offsetLeft/Top) → the browser renders fixed as: on-screen = (layout left − offsetLeft)×scale,
    //   so layout left = visX/scale **+** offsetLeft (plus! MDN's official approach goes the same way: fixed left = vv.offsetLeft) — on-screen is always = visX
    //   Mind the direction: a minus sign pushes the button further away with each pan until it goes off-screen (verified: "had to pan all the way left to see the button")

    // Visual size ↔ CSS size (counter-zoom is not uniform — this is the only conversion source; stop hand-computing ×scale/scaleY!)
    //   transform scale(1/scale) is always uniform (origin top-left); the page scales horizontally by scale, vertically by scaleY:
    //     visual_w = css_w                  (horizontal: 1/scale × scale = 1, exact cancel)
    //     visual_h = css_h × scaleY/scale   (vertical: 1/scale × scaleY ≠ 1)
    //   so css_w = visW, css_h = visH × scale/scaleY (_fixedVisual has no transform, css=visual directly)

    // Visual width cap (same source as the debug card): min of vp.w and visualViewport.width (always CSS, most reliable) minus margin — guards against vp.w being too large

    // Visual height cap (same as capVisW): vp.h (screen height, constant)


    // ---- Device physical size (CSS px, unaffected by page zoom/window resize): screen.width/height ----
    //   Page zoom (pinch/ctrl+/-) only changes visualViewport.scale; screen stays the same — large/small screen detection is stable (adapt to "physical size", not "zoomed size")
    //   Note: screen.width = device physical pixels / devicePixelRatio (e.g. iPhone 375CSS×dpr3 → 375; desktop 1280CSS×dpr1 → 1280)

    // ---- Large/small screen detection (multi-signal fusion, per ppk viewport research)----
    //  ① screen.width (CSS px): modern mobile browsers = ideal viewport (device DIP, e.g. 375); desktop Chrome/Safari = physical screen
    //  ② Old browser pitfall: Android old WebViews return physical pixels from screen (1080+) → misjudged as a large screen
    //     Fix: getPhysScreen multi-signal decision (UA-CH mobile + outerWidth/availWidth cross-check, tablets not falsely flagged)
    //  ③ Desktop Firefox/Edge pitfall: screen.width changes with page-zoom (ppk) — low frequency, accepted (Chrome/Safari stable)



    // ---- fab physical anchor: visual position pinned (counter-zoom on page zoom, a button hovering at the page edge doesn't scale with it) ----
  ctx.fabEdge = null; // 'left'|'right'|'top'|'bottom'
  ctx.navHoldT = 0; // navigation hold timestamp (set by doNav, read by updateHud/floatToolbar)
    // ---- Navigation (shared by toolbar button / keyboard hostKey): selection source routing (host selfEngaged → selfClient.step; target → postToTarget)----
    // Note: must be defined at top level (keyboard hostKey calls it at top level; it was originally defined inside buildToolbar → ReferenceError: doNav is not defined → keyboard fully dead)

  ctx.fabPhys = null; // {x, y} physical pixel position (visual target, unchanged by zoom)
  ctx.suppressClick = false; // fab drag end flag: swallow the following click (avoid accidentally toggling the button)
    // touch click tooltip: show the expanded text immediately, auto-hide after 2s (touch has no :hover out, the :hover expansion would stay stuck)
    ctx.fab.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'touch') {
        ctx.fab.classList.remove('dbg-nohover'); // new touch: restore tooltip capability
        ctx.fab.querySelectorAll('button').forEach(function (x) { x.classList.remove('dbg-tip'); });
        var b = e.target && e.target.closest ? e.target.closest('button') : null;
        if (b) b.classList.add('dbg-tip');
        if (ctx.fab.__tipT) clearTimeout(ctx.fab.__tipT);
        ctx.fab.__tipT = setTimeout(function () {
          ctx.fab.querySelectorAll('button').forEach(function (x) { x.classList.remove('dbg-tip'); });
          ctx.fab.classList.add('dbg-nohover'); // suppress leftover :hover expansion (after a tap, :hover persists until the next tap)
        }, 2000);
      }
    });
    // FAB drag (shared gesture utility makePointerDrag): the button area can also start a drag — movement beyond the threshold (6px) turns into a drag;
    // no movement = normal click (no preventDefault / no immediate capture, keeping the click landing on the button; capture strategy capture:'late' handled by the shared layer)
    makePointerDrag({
      handle: ctx.fab, threshold: 6, capture: 'late',
      onStart: function (e) {
        // Offset uses the visual target fabPhys (not the layout rect — rect is layout coords, clientX is visual coords; mixing pins the drag target to the initial layout position, unable to drag away)
        var vp0 = getPhysViewport();
        var coordLayout = detectCoordSemantics(ctx.fab, e.clientX); // is clientX layout or visual (CDP/WebView may report layout)
        // ox/oy are always visual offsets: clientX converted to visual by the detected semantics ×scale, then subtracted from fabPhys (visual) in the same frame
        var xv = e.clientX * (coordLayout ? vp0.scale : 1);
        var yv = e.clientY * (coordLayout ? vp0.scaleY : 1);
        return { ox: xv - (ctx.fabPhys ? ctx.fabPhys.x : 0), oy: yv - (ctx.fabPhys ? ctx.fabPhys.y : 0), coordLayout: coordLayout };
      },
      onMove: function (ev, st) {
        ctx.fab.classList.add('dbg-dragging'); // while dragging: disable hover lift/tooltip
        // clientX/Y converted to visual by the detected semantics: layout source ×scale (horizontal) / ×scaleY (vertical) → visual target; visual source used as-is
        var vp = getPhysViewport();
        var sx = st.coordLayout ? vp.scale : 1;
        var sy = st.coordLayout ? vp.scaleY : 1;
        ctx.fabPhys = { x: ev.clientX * sx - st.ox, y: ev.clientY * sy - st.oy };
        ctx.applyFabView();
      },
      onEnd: function (ev, st, moved) {
        ctx.fab.classList.remove('dbg-dragging');
        if (moved) { ctx.suppressClick = true; setTimeout(function () { ctx.suppressClick = false; }, 80); } // swallow the following click (avoid accidentally toggling the button)
        if (!moved) return;
        var vp = getPhysViewport();
        var r = ctx.fab.getBoundingClientRect();
        var vw = vp.w, vh = vp.h; // physical viewport
        // rect semantics: Chrome layout rect = layout coords (×scale→visual); iOS visual rect = visual coords (direct)
        var _rm = _fixedVisual ? 1 : vp.scale;
        var cx = (r.left + r.width / 2) * _rm, cy = (r.top + r.height / 2) * (_fixedVisual ? 1 : vp.scaleY);
        var dl = cx, dr = vw - cx, dt = cy, db = vh - cy;
        var minH = Math.min(dl, dr), minV = Math.min(dt, db);
        // Snap to the nearest edge (dragged past half the screen snaps to the opposite edge); the along-edge position (other axis) is kept by the refreshFabAnchor clamp
        ctx.fabEdge = (minV <= minH) ? (dt <= db ? 'top' : 'bottom') : (dl <= dr ? 'left' : 'right');
        ctx.fabPhys = { x: cx, y: cy };
        ctx.applyFabOrient();
        ctx.refreshFabAnchor(); // recompute the snap anchor for the new edge/orientation (offsetWidth/Height changed after the orientation switch)
        ctx.persistFabPos();
      },
    });
    // capture-phase interception: after a drag (movement beyond the threshold) swallow the button click to avoid accidentally triggering toggle
    ctx.fab.addEventListener('click', function (e) {
      if (ctx.suppressClick) { e.stopPropagation(); e.preventDefault(); }
    }, true);
    // Swallow bubbling of click/touch events on the fab — prevents them reaching the page/bottom iframe elements (a small-screen inspect click triggers the bottom hover popup)
    // Note: excludes pointerdown/pointerup/pointermove — dragging relies on their window-level listeners (onMove/onEnd)
    ['click', 'mousedown', 'mouseup', 'touchstart', 'touchend'].forEach(function (t) {
      ctx.fab.addEventListener(t, function (e) { e.stopPropagation(); });
    });
    // Swallow bubbling of launcher UI events (HUD/toolbar/panels/dialogs — all our own overlays) — release profiles (especially click) should only act on page elements:
    // our own UI events must never reach the original page. Otherwise, with "release all" active, clicking the toolbar 🔒 release profile dropdown to switch back to default,
    // that click bubbles to the page and gets caught by the "click outside closes menu" logic → the just-opened menu collapses (verified).
    // Attached uniformly at the #__dbg_launcher root (all our own overlays are its children): bubbling to the root triggers stopPropagation, page listeners receive nothing;
    // our UI's own handlers sit at element/root inner layers (they run before the root), unaffected.
    // Note: excludes pointermove/pointerup — fab/toolbar/HUD dragging depends on window pointermove/up (onMove/onEnd)
    // mousedown must be included: page popup menus commonly close on document mousedown (click outside closes menu) — if launcher UI mousedown leaks to the page,
    // it closes the just-opened menu (inspect flow: release → click page + popup menu → click the toolbar release button → menu closed, verified). fab already swallows mousedown; the root completes it.
    // Excludes pointercancel: the end listeners of all four drags (AI window drag/resize, fab, toolbar, HUD) hang on window pointercancel —
    // if the root swallowed it, when touch scroll takeover/system gestures trigger cancel the end listener receives nothing → dragState residue, window stuck (verified on pad: "drag once and it sticks").
    ['mouseup', 'mousedown', 'click', 'dblclick', 'contextmenu', 'pointerdown',
     'touchstart', 'touchmove', 'touchend', 'touchcancel',
     'mouseover', 'mouseout', 'mousemove', 'wheel', 'keydown', 'keyup', 'focusin', 'focusout', 'input', 'change'].forEach(function (t) {
      ctx.root.addEventListener(t, function (e) { e.stopPropagation(); });
    });
    // mousedown handled separately (capture phase, before the fab/toolbar internal stopPropagation): preventDefault stops launcher UI clicks from stealing page focus.
    // Page popup menus often rely on "close on input blur" (e.g. the session manager's tag editor onBlur→setEditing(false)→the whole picker unmounts):
    // with release-all on, after opening the menu, clicking our 🔒 release dropdown → the page input blurs → onBlur → menu closed (verified).
    // preventDefault blocks the default focusing (focus stays in the page input); the launcher's own inputs (selector etc.) are exempt.
    // Panel cards (.dbg-pick-dialog: notify/Q&A/pick-confirm) are exempt -- their bodies must stay
    // selectable and button clicks must be able to focus the document (Clipboard API requires a
    // focused document; unconditional preventDefault kills selection + copy, verified). Pages still
    // receive none of these events thanks to the root-level stopPropagation listeners above.
    ctx.root.addEventListener('mousedown', function (e) {
      if (e.target && e.target.closest && e.target.closest('input, textarea, select')) return;
      if (e.target.closest && e.target.closest('.dbg-pick-dialog')) return;
      try { e.preventDefault(); } catch (err) {}
    }, true);
    ctx.root.appendChild(ctx.fab);
    ctx.restoreFabPos(); // restore after mount (width/height must be correct to compute the physical anchor)
    // Correct the snap anchor once after styles fully apply (offsetWidth/font is only final after rAF — otherwise the first small-screen position may sit too far right and off-screen)
    requestAnimationFrame(function () { if (ctx.fabEdge) ctx.refreshFabAnchor(); });
    // Fallback delayed recompute: with "no zoom", vv resize/scroll events don't fire (scale unchanged); if vv.scale isn't ready (=1) at first computation the wrong scale is used —
    //   the position stays wrong and is never recomputed → invisible. Proactively recompute with delays to ensure the position is correct once vv.scale/size are ready (the "appears after refresh following a pinch" case is exactly this mechanism)

    [150, 600, 2000].forEach(function (ms) { setTimeout(ctx.safeFabRefresh, ms); });
    window.addEventListener('load', ctx.safeFabRefresh);
    // Zoom/window change listeners: page zoom → counter-zoom keeps the visual position; physical window change → recompute the snap anchor
    if (window.visualViewport) {
      // Zoom/pan change: recompute the snap anchor (refreshFabAnchor — fixes initial misalignment when vv first becomes ready/scale changes) + apply the visual position
      window.visualViewport.addEventListener('resize', function () { ctx.refreshFabAnchor(); ctx.applyFabView(); ctx.applyToolbarZoom(); ctx.applyToolbarCompact(); ctx.applyHudZoom(); ctx.applyAiState(); });
      window.visualViewport.addEventListener('scroll', function () { ctx.refreshFabAnchor(); ctx.applyFabView(); ctx.applyToolbarZoom(); ctx.applyToolbarCompact(); ctx.applyHudZoom(); ctx.applyAiState(); });
    }
    window.addEventListener('resize', function () {
      ctx.refreshFabAnchor(); // any viewport change recomputes the snap anchor + clamp (incl. mobile emulation scale≠1: the old position would overflow the screen, must recompute)
      ctx.applyToolbarZoom();
    });

    // ---------------- Target = host + host's real iframes (phase 3: no self-built preview) ----------------
  ctx.aiIframe;
  ctx.inspectorOn = false;
  ctx.hudHoverOn = false; // HUD simulated hover switch (real event dispatch, pinned on the current element)
  ctx.pendingCommands = {};   // requestId -> {resolve, reject} (AI command round trips)

    // ---------------- Page speed/intercept options (animation slowdown/event interception/timer slowdown) ----------------

  ctx.optState = Object.assign({
      animSpeed: 1, blockScroll: false, blockWheel: false, slowTimers: 1,
      netDelay: 0, netOffline: false, darkMode: false, reducedMotion: false,
      timeOffsetMs: 0, viewportW: 0, simulateTouch: false,
      dangerAutoOkMs: 30000, // dangerous command unattended default 30s: if no response 30s after the confirm card pops, execution is auto-approved (speed panel can change to 0/10/30/60s)
    }, ctx.loadOptState());
  ctx.errLog = []; // page error log (for scene capture, cap 20)
  ctx.aiInspectActive = false; // AI window pick mode (picked elements are reported back to the AI window; no dialog, continuous picking)
  ctx.selfEngaged = false;     // host page selection locked (distinguishes host/target when an AI pick is confirmed)
  ctx.lastSelfPayload = null;  // host page latest selection payload (carried by hover/engaged messages — for reporting back to the AI window)
  ctx.speedPanel = null;




    /** Ensure the target iframe is created and injection completed (for self-check/testing) */


    // Force-verify the client is the latest version (guards against stale leftovers — missing exit cleanup/new capabilities would allow picking after exit)
    // Old instance: exitInspector cleans up listeners + removes + reinjects the latest MINI_DBG_CLIENT




    // ---------------- Dangerous command user confirmation (when the AI simulates CDP via postMessage, destructive/persistent commands need user approval) ----------------
;
    // Browser-restricted operations: programmatic execution is blocked; a real user click must provide user activation (every time, cannot be "remembered")
;
  ctx.gestureCard = null;
  ctx.sessionDangerOk = false; // "remember for this session" — once checked, dangerous commands skip per-command confirmation for the rest of the session
  ctx.confirmCard = null;
  ctx.simReqN = 0;
  ctx.dangerQueue = [];     // dangerous command confirmation queue (confirmed one by one under concurrency, preventing confirm cards overwriting each other)
  ctx.confirmingDanger = false;

    /** AI command entry (with danger confirmation/gesture bridge): shared by the dbg_command message / simulateAiCommand / MCP bridge; returns a result promise */


    // Browser commands run in the host: the gesture card click happens in the host (has transient activation); without a gesture inside the target iframe the browser rejects it








    // Release profiles (polymorphic): default = current profile (locks click/hover only); release all (incl. click) / freeze all / custom p1-p3 (managed by the speed panel)
    // Release profiles: built-in (default/release all/freeze all, undeletable) + user-defined (profile name+content can be added/removed/edited, persisted to localStorage)
  ctx.RELEASE_PROFILES = {
      default: { name: 'default', label: t('⚡ Default allow'),   release: ['key', 'wheel', 'scroll', 'touch', 'focus'], builtin: true },
      all:     { name: 'all',     label: t('⚡⚡ Allow all'), release: ['click', 'hover', 'key', 'wheel', 'scroll', 'touch', 'focus'], builtin: true },
      frozen:  { name: 'frozen',  label: t('⛔ Freeze all'), release: [], builtin: true },
    };
    // Default release categories are user-editable (persisted; default = everything released except click/hover)

    try {
      var _dr = localStorage.getItem(DEFAULT_RELEASE_KEY);
      if (_dr) {
        var _arr = JSON.parse(_dr);
        if (Array.isArray(_arr)) {
          var _valid = ['click', 'hover', 'key', 'wheel', 'scroll', 'touch', 'focus'].filter(function (c) { return _arr.indexOf(c) >= 0; });
          ctx.RELEASE_PROFILES.default.release = _valid;
        }
      }
    } catch (e) {}

  ctx.userProfiles = ctx.loadUserProfiles();
  ctx.userProfileSeq = 0; // generate a unique name






  ctx.currentProfile = 'default';


  ctx.toolbarHovering = false; // mouse on the toolbar: freeze position, allow clicks (avoids a follow loop)
    // Bottom info bar (HUD): live display of candidate element info during hover quick-pick + click hint (modeled on the Chrome inspector)
  ctx.hud = null;
  ctx.hudUserPos = null; // HUD user-dragged fixed position (doesn't follow the selection; reset on exiting Inspector)

 // Reset on exiting Inspector (restore following the selection)

  ctx.lastHud = null; // latest hover data (for resize repositioning — setHovered short-circuits on the same element without re-posting)

    window.addEventListener('resize', function () {
      // Viewport change (small screen/window resize) → HUD reposition (keep it fully visible — setHovered same-element short-circuit doesn't re-post)
      if (ctx.hud && ctx.hud.style.opacity === '1' && ctx.lastHud) {
        if (!ctx.hudUserPos) ctx.updateHud(ctx.lastHud.p, ctx.lastHud.source);
        else {
          // The dragged fixed position is also clamped within the viewport (visual px — avoids hiding beyond the viewport after zoom)
          var _vp = getPhysViewport();
          var _r = ctx.hud.getBoundingClientRect();
          var _ux = ctx.hudUserPos.x, _uy = ctx.hudUserPos.y;
          _ux = Math.min(Math.max(4, _ux), Math.max(4, _vp.w - Math.min(_r.width * _vp.scale, 60) - 4));
          _uy = Math.min(Math.max(4, _uy), Math.max(4, _vp.h - Math.min(_r.height * _vp.scale, 60) - 4));
          ctx.hudUserPos = { x: _ux, y: _uy };
          ctx.hud.__vis = { left: _ux, top: _uy };
          ctx.applyHudZoom();
        }
      }
    });

    // HUD counter-zoom: by the real screen size (visualViewport.scale × inner = physical viewport) — visual size/position stays fixed while the page zooms





    // Toolbar floats following the selection (above it, avoiding the finger/mouse)
  ctx.toolbarDragged = false; // after the user drags the toolbar: position takes priority (only re-fits on selection change)
  ctx.lastSelRect = null;     // last selection rect (compared after a drag: same selection doesn't move, new selection re-fits)

    // Re-fit the toolbar (# dialog open/close changes the toolbar height → avoidance recompute; doesn't trigger the drag-priority logic)

    // Toolbar counter-zoom: inverse scale on page zoom + position÷scale, visual size/position stays fixed (doesn't follow the page zoom)

    // ---- Toolbar mouse drag (hold a non-button area such as the selection info bar): after dragging, position takes priority; selection change auto-fits ----
    // Note: cannot use the toolbar variable from toolbar build subfunctions (window.toolbar is a BOM object); always look it up dynamically

    ctx.attachToolbarDrag();


    // ---------------- Speed/intercept panel (animation slowdown/event interception/timer slowdown) ----------------



    // ---------------- One client injected into the host itself + recursively into same-origin iframes (self-inspect, unified across both zones) ----------------
    // The host page and iframes share one MINI_DBG_CLIENT: the host page runs it in __DBG_POST__ callback mode; iframes go through parent.postMessage
  ctx.selfClient = null; // the host page's own client instance
  ctx.selfClientActive = false; // 🖥 button independent activation state


    // Inject a single same-origin iframe: wait for load if not loaded, then recurse into its child pages after injection

    // Inject all same-origin iframes (child pages all get injected at once; the AI iframe is skipped)

    // Continuous watching: observe every injected document (host + each iframe); dynamically added iframes are auto-injected (chained)






    // Scene snapshot: error list + simulated conditions + page state → sent to the AI


    // ---------------- AI floating window (aiUrl; draggable/snap-to-edge/free width & height, position remembered in localStorage) ----------------
  ctx.aiReady = false;
  ctx.aiQueue = [];
  ctx.aiWin = null;
  ctx.aiState = null;







    // Whether the AI window is visible on screen (visual area>40%) — reset to default when stale data/viewport changes push it off-screen/invisible






    // Bind the AI iframe URL after connection is allowed: bridge address+token injected into the AI window (ai.html reads the params to show status, for path 1 bridge→AI window→page)


    // ---------------- System log (AI main window = ai.html: chat + CDP simulation unified; logs forwarded to the AI window for display) ----------------


    // ---------------- Message routing: host ⇄ target UI ⇄ AI (all async postMessage) ----------------



    /** AI command forwarded to the target UI via the host; requestId correlates the async result, which returns via the same path */

    ctx.execInPage._n = 0;





    // ---------------- Switches ----------------

    ctx.aiBtn.addEventListener('click', ctx.toggleAi);

    // ---------------- Inspector: three-step pick + selection fine-tuning (desktop hover / touch tap-to-move) ----------------

    // Touch: suppress button :hover leftovers (after a tap, avoids the messy visual of 'hovering the whole window') — doesn't depend on toolbar readiness
    ctx.root.classList.toggle('dbg-touch-ui', isTouchDevice());
    // Small-screen detection (tiered): the target page may not adapt to small screens, but our toolbar detects on its own and scales up
    //   compact = viewport<768 or touch → buttons 38px/16px; touch = touch or viewport<480 → buttons 44px/18px (touch target standard)



    ctx.root.classList.toggle('dbg-touch-ui', isTouchDevice()); // touch: suppress button :hover leftovers (after a tap, avoids 'hovering the whole window')
    window.addEventListener('resize', function () { ctx.applyToolbarCompact(); });
    // Delayed 1s scan after Inspect opens: list fixed/transparent layers covering a large viewport area (locating the source of the 'light-blue full-window overlay') → pop an independent copyable box at the top + console
    // body/html tinting attribute diagnostics (user: 'body got tinted light blue by nearby attributes; deleting and rebuilding body fixed it') — no big dialog, just a small corner badge at the top-right, copyable

    // Independent fallback: remove selection frame divs left in the target document (pure DOM ops, no recursion; called even if exitInspector throws internally)



    ctx.inspBtn.addEventListener('click', function (e) { e.stopPropagation(); ctx.inspectorOn ? ctx.exitInspector() : ctx.enterInspector(); });

    // Activate/exit the client of same-origin iframes inside the host page (nested — AI pick/Inspector can select elements inside iframes; launcher-internal target/AI are excluded)



    // ---------------- Preview + checkboxes + indicator dialog (step three) ----------------
  ctx.dialog = el('div', { class: 'dbg-dialog' });
  ctx.cardDlg = el('div', { class: 'dbg-dialog-card' });
  ctx.dHead = el('div', { class: 'dbg-dialog-head' });
  ctx.dTag = el('code', {}, ['?']);
  ctx.dLoc = el('span', { class: 'dbg-loc' }, ['']);
    ctx.dHead.appendChild(ctx.dTag);
    ctx.dHead.appendChild(ctx.dLoc);
  ctx.dClose = el('button', {}, ['✕']);
    ctx.dHead.appendChild(ctx.dClose);
  ctx.dBody = el('div', { class: 'dbg-dialog-body' });

    // Preview area: element summary (confirm what got selected)
  ctx.preview = el('div', { class: 'dbg-preview' });
    ctx.dBody.appendChild(ctx.preview);

    // Checkbox area: which info to bring to the AI (R7 optional)
  ctx.checks = el('div', { class: 'dbg-checks' });
  ctx.checkDefs = [
      ['text', t('Text')], ['computed', t('Styles')], ['attrs', t('Attributes')], ['xpath', t('Locate')], ['framework', t('Framework / file location')],
    ];
  ctx.checkBoxes = {};
    ctx.checkDefs.forEach(function (c) {
      var label = el('label', {}, []);
      var box = el('input', { type: 'checkbox' });
      box.checked = true;
      ctx.checkBoxes[c[0]] = box;
      label.appendChild(box);
      label.appendChild(document.createTextNode(c[1]));
      ctx.checks.appendChild(label);
    });
    ctx.dBody.appendChild(ctx.checks);

  ctx.dFoot = el('div', { class: 'dbg-dialog-foot' });
  ctx.dCancel = el('button', { class: 'dbg-ghost' }, [t('Cancel')]);
  ctx.dSend = el('button', { class: 'dbg-primary' }, [t('Send to AI')]);
    ctx.dFoot.appendChild(ctx.dCancel);
    ctx.dFoot.appendChild(ctx.dSend);
    ctx.cardDlg.appendChild(ctx.dHead);
    ctx.cardDlg.appendChild(ctx.dBody);
    ctx.cardDlg.appendChild(ctx.dFoot);
    ctx.dialog.appendChild(ctx.cardDlg);
    ctx.root.appendChild(ctx.dialog);



  ctx.lastPayload = null;

    ctx.dClose.addEventListener('click', ctx.closePreview); // preview close → back to the toolbar (doesn't exit inspect — the user wants the preview to be optional)
    ctx.dCancel.addEventListener('click', ctx.closePreview);

    ctx.dSend.addEventListener('click', function () {
      if (!ctx.lastPayload) return;
      ctx.closeDialog();
      // Ensure the AI window exists (otherwise postToAi drops it — the candidate never gets sent)
      try { ctx.ensureAi(); ctx.showAi(true); ctx.aiOpen = true; ctx.aiBtn.classList.add('dbg-on'); } catch (e) {}
      // host 🎯 inspect sent to the AI: go through the extension-handled path (dbg_ai_element candidate → pi-web composer [element N]) —
      //   the original sendToAi(db_user_message) to pi-web was dropped by the extension (verified: "clicking send-to-AI didn't deliver")
      try { ctx.picksAddElement(ctx.enrichElPayload ? ctx.enrichElPayload(ctx.lastPayload) : ctx.lastPayload); }
      // Fallback catch (only on picksAddElement exception): this device is the "host sending an element to AI" side, so attribution is always AI (_selfAttrib:false) —
      // even if selfAiRequested is disturbed at this moment, force-send to the AI window instead of landing on host self.
      catch (e) { ctx.postToAi({ type: 'dbg_ai_element', _selfAttrib: false, payload: ctx.lastPayload }); }
      ctx.addMsg('sys', t('Sent selected element (') + ctx.lastPayload.tag + t(') to AI — [element N] placed in the composer, press send.'));
    });

    // ---------------- Global message entry (host ⇄ target UI / AI) ----------------
    // hover debug panel: shows details when a hover takes effect or is suppressed/excluded, copyable (for the user pasting to the AI to analyze the 'blue box around the whole page' scenario)



    window.addEventListener('message', ctx.onHostMessage);

    // Keyboard navigation: when the toolbar is shown (engaged locked) intercept the shortcuts for our own use; outside Inspector / hover quick-pick, release keys to the page
;
    // Keyboard handling shared (host + target iframe forwarding): when the toolbar is shown (locked state) intercept the shortcuts for our own use; when unlocked, release keys to the page

    document.addEventListener('keydown', function (e) { ctx.hostKey(e); });
    // Keyboard inside the target iframe: after picking an iframe element, keyboard focus is in the iframe (the host document keydown won't receive it — "feels like there is no keyboard listener at all")
    // Note: the iframe is created by ensureTarget() (this block sits before it) — the binding runs after the trailing ensureTarget() and re-binds on load


    // Destroy: remove message listeners + the whole overlay (used by the test center when switching frameworks)


    // ---------------- Exposed handles ----------------
    // ---- Toolbar build (phase 3: independent of any iframe; selection directed by selFrameId) ----
    try { ctx.buildToolbar(); } catch (e) {}
    // ---- AI window pre-creation (hidden + iframe preload, ready on open) + restore from memory on refresh ----
    // Lifecycle: the AI window is created at launcher load (iframe warm-up) but hidden by default (CSS .dbg-ai-win{display:none});
    //   shown only when "it was open before the last close" (dbgState.aiOpen) or when the user clicks the AI button
    // New-window mode restore: set the restore flag first — the ensureAi popup branch sees the flag and doesn't window.open immediately (the same-name window would be reused and navigated away, losing the popup session),
    //   instead it waits for the popup heartbeat adopt (10s timer fallback: only calls openAiPopup if there's no heartbeat)
    try { ctx._restoringPopup = !!(ctx.dbgState.aiOpen && (ctx.loadAiState ? (ctx.loadAiState().mode === 'popup') : false)); } catch (e) { ctx._restoringPopup = false; }
    if (ctx.selfHostPage) {
      ctx.aiOpen = false; // self host page: skip AI window pre-creation and refresh restore — the page itself is the AI window; building another is nesting redundancy
    } else {
    try { ctx.ensureAi(); } catch (e) {}
    if (ctx.dbgState.aiOpen) {
      if (ctx.aiMode === 'popup') {
        // New-window mode restore: after a host refresh the ctx.aiPopup handle is lost, but the popup's window.opener still points here (preserved across refreshes) —
        // first wait for the popup heartbeat (aiti-client sends dbg_ai_ready every 5s) → handleClientMessage auto-adopts e.source, rebuilding the reference;
        // the popup doesn't reload, so the session survives. If 10s pass with no heartbeat (popup closed/navigated away) → window.open the same-name window: if present, reuse and reclaim (navigate back to the AI URL);
        // if absent, create a new one (without a user gesture it's mostly blocked → openAiPopup falls back to embedded internally)
        ctx.aiOpen = true;
        ctx.aiBtn.classList.add('dbg-on');
        ctx.saveDbgState();
        ctx.addMsg('sys', t('🔄 Restoring AI standalone window (waiting for response…)'));
        setTimeout(function () {
          try {
            if (ctx.aiPopup && !ctx.aiPopup.closed) { ctx.showAi(true); return; } // heartbeat already claimed, popup didn't reload
            ctx._restoringPopup = false;
            ctx.openAiPopup(); // no heartbeat → popup closed/never opened: same-name reuse or create new (blocked → openAiPopup falls back to embedded internally)
          } catch (e) {}
        }, 10000);
      } else {
        try {
          ctx.showAi(true);
          ctx.aiOpen = true;
          ctx.aiBtn.classList.add('dbg-on');
          ctx.addMsg('sys', t('🔄 Debug session restored (AI window was open before refresh, auto-reopened).'));
        } catch (e) {
          ctx.addMsg('sys', t('⚠ AI window auto-restore failed: ') + ((e && e.message) || e) + t('(can report to the AI in its window for fixes)'));
        }
      }
    }
    }
    ctx.saveDbgState(); // first state write (includes the current config)

    // ---- Load-complete toast: show the detected large/small screen info (debug: verify screen/visual viewport/detection on real devices)----
    // 2026-08 re-enabled (for real-device verification after this round's scaleY/transform uniform-ratio fix; change back to if (false) when unneeded)
    // ---- Debug info window (replaces the temporary toast) + settings (AI window header ⚙)----
    // Persistence: whether to auto-show the debug info on refresh (default on; once off, it won't auto-pop next time, still viewable manually from settings)

 // Default off: don't auto-pop the debug card on load (it would cover the page)


    // Debug info text (screen/inner/vp/fab/AI) — copy to the AI to assist diagnosis

    // Centered card positioning (small screens counter-zoom for readable content; desktop normal)

  ctx.debugPanel = null;

    // Settings dialog (triggered from the AI window header ⚙): debug info auto-show toggle + manual view

    // Auto-show the debug info window on refresh (can be turned off in settings/the debug window; once off, it won't auto-pop next time)
    if (ctx.loadShowDebug()) {
      try {
        ctx.showDebugPanel();
        [150, 600, 2000].forEach(function (ms) { setTimeout(function () { try { if (ctx.debugPanel && ctx.debugPanel.classList.contains('dbg-open')) ctx.debugPanel._info.textContent = ctx.dbgInfoText(); } catch (e) {} }, ms); });
      } catch (e) {}
    }

    ctx.root.__dbgLauncher = {
      url: ctx.url, version: VERSION, cfg: ctx.cfg,
      enterInspector: ctx.enterInspector, exitInspector: ctx.exitInspector,
      enterSelfClient: ctx.enterSelfClient, exitSelfClient: ctx.exitSelfClient,
      applyProfile: ctx.applyProfile, // release profile switch (default/all/p1/p2/p3/frozen)
      applyViewport: function (v) { ctx.optState.viewportW = v; ctx.saveOptState(); ctx.saveDbgState(); ctx.applyOptsToTarget(); }, // viewport emulation (change iframe width)
      open: ctx.toggleAi, sendMessage: ctx.sendText, execInPage: ctx.execInPage,
      // Target routing layer (plan C): T_HOST / listFrames / frameClient / postToFrame
      T_HOST: ctx.T_HOST, listFrames: ctx.listFrames, frameClient: ctx.frameClient, postToFrame: ctx.postToFrame, selFrameId: ctx.selFrameId, currentFrameId: ctx.currentFrameId,
      openAi: function () { ctx.aiOpen = true; ctx.ensureAi(); ctx.showAi(true); ctx.aiBtn.classList.add('dbg-on'); ctx.saveDbgState(); }, // auto-open the AI window (doesn't exit Inspector; distinct from toggleAi's mutual-exclusion logic)
      postToAi: ctx.postToAi, broadcast: ctx.broadcast,
      // Compat: targetWindow() = the first host iframe's window (the target page placed by the hub)
      targetWindow: function () { return (ctx.listFrames()[0] || {}).win || null; },
      captureSceneSend: ctx.captureSceneSend,
      simulateAiCommand: function (cmd, args) {
        return ctx.handleAiCommand({ cmd: cmd, args: args || {}, requestId: 'sim_' + (++ctx.simReqN) });
      }, // simulate an AI command (with danger confirmation); for self-check/testing
      destroy: ctx.destroy,
    };
    // Anti-nesting fallback watch window: at startup the shared library markers may not have loaded yet (aiti-client/host-protocol both load later than the defer script),
    // and business routing may strip the _dbg param — poll briefly after startup and self-destruct as soon as a marker appears (the UI/pre-created AI window iframe are removed together,
    // preventing dev ai inside prod ai from nesting layer by layer and dragging the main thread to death)
    var _nestN = 0, _nestIv = setInterval(function () {
      _nestN++;
      if (aiWindowMarkers()) {
        clearInterval(_nestIv); _nestIv = null;
        try { if (window.console && console.warn) console.warn('[aiti] 运行期检测到 AI 窗特征——launcher 自毁（防嵌套）'); } catch (e) {}
        try { ctx.destroy(); } catch (e) {}
        try { if (ctx.aiIframe) { ctx.aiIframe.src = 'about:blank'; ctx.aiIframe.remove(); ctx.aiIframe = null; } } catch (e) {}
        try { var _r = document.getElementById('__dbg_launcher'); if (_r && _r.parentNode) _r.parentNode.removeChild(_r); } catch (e) {}
      } else if (_nestN > 40) { clearInterval(_nestIv); _nestIv = null; } // stop polling after 10s
    }, 250);

    return ctx.root.__dbgLauncher;
}
