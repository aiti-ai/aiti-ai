// DOM factory + styles (split out from dbg-launcher.js; source block: host DOM factory)
export function el(tag, attrs, children) {
  var node = document.createElement(tag);
  if (attrs) for (var k in attrs) node.setAttribute(k, attrs[k]);
  (children || []).forEach(function (c) {
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return node;
}

// Lucide outline SVG helper (same style as built-in/extension icons: stroke currentColor + strokeWidth 2) -- icon buttons in the launcher all use this
var SVG_NS = 'http://www.w3.org/2000/svg';
export function elSvg(paths, size, strokeWidth) {
  var svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', String(size || 16));
  svg.setAttribute('height', String(size || 16));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(strokeWidth || 2));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  (paths || []).forEach(function (d) {
    var p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  });
  return svg;
}
// Common Lucide icons for the launcher (inspect crosshair = crosshair, same pick icon as the aiti-devtools top bar)
export var LUCIDE = {
  crosshair: ['M22 12h-4', 'M6 12H2', 'M12 6V2', 'M12 22v-4', 'M12 12'],
  // copy (overlapping squares) / check (tick): header one-click copy + success feedback on the notify
  // card -- same shapes as the pi-web host message copy button
  copy: ['M9 11a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2z', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'],
  check: ['M20 6 9 17l-5-5'],
};

  export function ensureStyles(accent) {
    if (document.getElementById('__dbg_launcher_css')) return;
    var css = document.createElement('style');
    css.id = '__dbg_launcher_css';
    css.textContent = `
      /* The launcher is the topmost overlay (highest z-index, no iframe/div can cover it); pointer-events pass-through so page interaction is not blocked */
      /* Disable the browser touch tap highlight on this tool's UI (Android Chrome/HarmonyOS overlays a pale translucent blue mask on round buttons, looking like a square background/full-window mask) + long-press menu */
      #__dbg_launcher, #__dbg_launcher * { -webkit-tap-highlight-color: transparent; -webkit-touch-callout: none; }
      #__dbg_launcher {
        all: initial; font: 13px/1.5 system-ui, sans-serif; color: #1f2937;
        position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;
      }
      #__dbg_launcher > * { pointer-events: auto; } /* interactive children become clickable again */
      /* Info/tooltip overlays always pass clicks through: making #__dbg_launcher > * clickable would accidentally catch them (at opacity:0 they still intercept clicks on elements below -- block-tip/tooltip were observed blocking clicks);
         the hud grip .dbg-hud-grip sets pointer-events:auto explicitly on children to override the inherited none, staying draggable */
      #__dbg_launcher > .dbg-hud,
      #__dbg_launcher > .dbg-tooltip,
      #__dbg_launcher > .dbg-block-tip,
      #__dbg_launcher > .dbg-pick-toast { pointer-events: none; }
      #__dbg_launcher *, #__dbg_launcher *::before, #__dbg_launcher *::after { box-sizing: border-box; }
      .dbg-fab { position: fixed; right: 18px; z-index: 2147483646; display: flex; flex-direction: column; gap: 8px; touch-action: none; user-select: none; -webkit-user-select: none; }
      .dbg-fab.dbg-horz { flex-direction: row; } /* docked top/bottom: buttons laid out horizontally */
      .dbg-fab button {
        display: flex; align-items: center; justify-content: center; gap: 4px; width: 40px; height: 40px; padding: 0;
        border: 1px solid rgba(0,0,0,.12); border-radius: 50%; cursor: pointer;
        background: #fff; box-shadow: 0 2px 8px rgba(0,0,0,.18); font: inherit; white-space: nowrap; transition: all .2s;
      }
      .dbg-fab button::after { content: attr(data-label); font-size: 11px; opacity: 0; max-width: 0; overflow: hidden; transition: all .25s; }
      .dbg-fab button:hover { transform: translateY(-1px); }
      /* Tooltip expanding text: with fixed round buttons (40px) inline flow cannot push it -- left/right both switch to absolute positioning so icons/layout are not pushed */
      .dbg-fab button::after { content: attr(data-label); font-size: 11px; opacity: 0; max-width: 0; overflow: hidden; transition: all .25s; color: inherit; }
      .dbg-fab button[data-tip='left'], .dbg-fab button[data-tip='right'] { position: relative; }
      .dbg-fab button[data-tip='left']::after, .dbg-fab button[data-tip='right']::after {
        position: absolute; top: 50%; transform: translateY(-50%);
        max-width: 0; opacity: 0; overflow: hidden; white-space: nowrap; transition: all .25s;
        color: #374151; /* dark text -- when dbg-on sets button color:#fff, inheriting would give white-on-white invisible text */
      }
      .dbg-fab button[data-tip='left']::after { right: calc(100% + 2px); }
      .dbg-fab button[data-tip='right']::after { left: calc(100% + 2px); }
      .dbg-fab button[data-tip='left']:hover::after, .dbg-fab button[data-tip='right']:hover::after {
        max-width: 90px; opacity: 1; padding: 2px 6px; background: rgba(255,255,255,.95); border-radius: 8px;
      }
      /* While dragging: disable hover lift + hide the tooltip (avoids flicker) */
      .dbg-fab.dbg-dragging button { transform: none !important; }
      .dbg-fab.dbg-dragging button::after { opacity: 0 !important; max-width: 0 !important; }
      .dbg-fab button.dbg-on { background: ${accent}; color: #fff; border-color: ${accent}; }
      /* Page error alert: AI button red outline + corner badge (dot/count) + pulse animation (triggered per new error; slow rhythm, long enough duration to stay visible) */
      .dbg-fab button.dbg-err { position: relative; border-color: #ef4444; box-shadow: 0 0 0 1px rgba(239,68,68,.35) inset; }
      .dbg-fab button.dbg-err-pulse { animation: dbg-fab-err-pulse 1.5s ease-out 4; } /* slow glow spread, 4 cycles ≈ 6s */
      @keyframes dbg-fab-err-pulse {
        0% { box-shadow: 0 0 0 0 rgba(239,68,68,.7), 0 0 0 1px rgba(239,68,68,.35) inset; }
        25% { box-shadow: 0 0 0 6px rgba(239,68,68,.35), 0 0 0 1px rgba(239,68,68,.35) inset; }
        55% { box-shadow: 0 0 0 14px rgba(239,68,68,0), 0 0 0 1px rgba(239,68,68,.35) inset; }
        100% { box-shadow: 0 0 0 0 rgba(239,68,68,0), 0 0 0 1px rgba(239,68,68,.35) inset; }
      }
      .dbg-fab-err-badge {
        position: absolute; top: -4px; right: -4px; z-index: 2;
        min-width: 16px; height: 16px; padding: 0 4px; border-radius: 999px;
        background: #ef4444; color: #fff; font-size: 10px; font-weight: 700; line-height: 16px;
        display: flex; align-items: center; justify-content: center; border: 1.5px solid #fff;
      }
      /* Touch tap: show the tooltip immediately and hide it after 2s (touch has no :hover out, so it would stay expanded forever) */
      .dbg-fab button.dbg-tip::after { opacity: 1; max-width: 90px; padding-left: 2px; }
      .dbg-fab button[data-tip='left'].dbg-tip::after, .dbg-fab button[data-tip='right'].dbg-tip::after { max-width: 90px; opacity: 1; padding: 2px 6px; background: rgba(255,255,255,.95); }
      .dbg-fab.dbg-nohover button:hover::after, .dbg-fab.dbg-nohover button.dbg-tip::after { opacity: 0 !important; max-width: 0 !important; }
      /* Touch: disable :hover visuals on fab/toolbar/menu buttons (after a touch tap the :hover state sticks, causing a 'hovering the whole window' mess) --
         tooltips explicitly triggered via the dbg-tip class are unaffected (still shown 2s per tap); button :hover background/lift fully suppressed */
      #__dbg_launcher.dbg-touch-ui .dbg-fab button:hover,
      #__dbg_launcher.dbg-touch-ui .dbg-toolbar button:hover,
      #__dbg_launcher.dbg-touch-ui .dbg-extreme-menu button:hover,
      #__dbg_launcher.dbg-touch-ui .dbg-profile-item:hover,
      #__dbg_launcher.dbg-touch-ui .dbg-ai-bar button:hover,
      #__dbg_launcher.dbg-touch-ui .dbg-settings button:hover,
      #__dbg_launcher.dbg-touch-ui .dbg-speed button:hover { background: inherit !important; border-color: inherit !important; transform: none !important; }
      #__dbg_launcher.dbg-touch-ui .dbg-fab button:hover::after { opacity: 0 !important; max-width: 0 !important; }
      /* ---- Inspector toolbar (floating button row: selection adjustments) ---- */
      /* Toolbar: two rows (row 1 = stable selection info, row 2 = stable buttons that do not jump); color coding (nav light gray / ✓ green / 🖱 purple / ⏱ orange / 🔒 indigo / ✕ red) */
      .dbg-toolbar {
        display: none; flex-direction: column; padding: 4px 6px;
        background: rgba(255,255,255,.98); border: 1px solid #e2e8f0; border-radius: 10px;
        font-size: 12px; box-shadow: 0 4px 16px rgba(0,0,0,.14);
        touch-action: none; user-select: none; -webkit-user-select: none;
      }
      .dbg-toolbar.dbg-on { display: flex; }
      .dbg-toolbar.dbg-floating { position: fixed; z-index: 2147483647; } /* topmost layer: toolbar stays clickable while the confirm dialog (2147483645) is open */
      .dbg-toolbar-row { display: flex; align-items: center; gap: 2px; white-space: nowrap; }
      .dbg-toolbar-row.dbg-toolbar-btns { margin-top: 3px; flex-wrap: wrap; }
      .dbg-toolbar .dbg-sel-label {
        font-size: 10px; color: #64748b; min-width: 120px; max-width: min(60vw, 360px);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; word-break: break-all; overflow-wrap: anywhere;
        padding: 1px 4px;
        background: #f8fafc; border-radius: 5px; cursor: grab;
      }
      .dbg-toolbar button {
        min-width: 26px; height: 26px; padding: 0 5px; border: 0; border-radius: 8px;
        font-size: 12px; cursor: pointer; color: #334155; background: #f1f5f9; transition: background .15s;
      }
      .dbg-toolbar button:hover { background: #e0e7ff; }
      .dbg-toolbar .dbg-toolbar-sep { width: 1px; height: 22px; background: #e2e8f0; margin: 0 5px; flex: none; }
      .dbg-toolbar .dbg-nav-ok { background: #dcfce7; color: #15803d; }
      .dbg-toolbar .dbg-nav-resume { background: #f3e8ff; color: #7e22ce; }
      .dbg-toolbar .dbg-nav-profile { background: #e0e7ff; color: #4338ca; }
      .dbg-toolbar .dbg-nav-close { background: #fee2e2; color: #b91c1c; }
      .dbg-toolbar .dbg-nav-help { background: #fef3c7; color: #b45309; }
      /* Selector quick-pick input row */
      .dbg-sel-input-row { display: none; margin-top: 3px; flex-direction: column; } /* input on its own row, example hint on a separate row */
      .dbg-sel-input-row input {
        width: 100%; box-sizing: border-box; border: 1px solid #c7d2fe; border-radius: 6px; padding: 4px 8px;
        font: inherit; font-size: 11px; background: #eef2ff;
      }
      .dbg-sel-hint { font-size: 10px; color: #94a3b8; line-height: 1.5; margin-top: 2px; }
      /* Small-screen adaptation (the target page may not be small-screen friendly, so the toolbar scales itself up):
         compact = viewport <768 or touch → buttons 38px/16px; touch = touch or <480 → buttons 44px/18px (touch standard) */
      .dbg-toolbar.dbg-compact {
        padding: 5px 8px; max-width: calc(100vw - 16px); flex-wrap: wrap; gap: 4px;
      }
      .dbg-toolbar.dbg-compact button { min-width: 36px; height: 38px; font-size: 16px; padding: 0 8px; }
      .dbg-toolbar.dbg-compact .dbg-sel-label { min-width: 150px; font-size: 12px; }
      .dbg-toolbar.dbg-compact .dbg-toolbar-btns { flex-wrap: wrap; }
      .dbg-toolbar.dbg-touch {
        padding: 6px 10px; gap: 6px;
      }
      .dbg-toolbar.dbg-touch button { min-width: 44px; height: 46px; font-size: 18px; padding: 0 10px; }
      .dbg-toolbar.dbg-touch .dbg-sel-label { min-width: 170px; font-size: 14px; padding: 4px 8px; }
      .dbg-toolbar.dbg-touch .dbg-toolbar-btns { gap: 6px; }
      .dbg-toolbar.dbg-touch .dbg-sel-input-row input { font-size: 14px; padding: 8px 10px; }
      /* Button-click tooltip (disappears after a few seconds) */
      .dbg-hud {
        position: fixed; z-index: 2147483647; /* topmost layer: drag/display not covered by any UI (fab/toolbar/panel) */
        background: rgba(17,24,39,.94); color: #e5e7eb; border-radius: 10px; padding: 7px 12px;
        font-size: 11px; line-height: 1.65; min-width: 140px;
        transition: opacity .25s; pointer-events: none; opacity: 0; box-shadow: 0 6px 20px rgba(0,0,0,.4);
      }
      /* Small screen/touch: HUD (based on the real physical viewport; media queries fail when layout=980); compact icons (small screens are info-dense, keep them from taking screen space) */
      #__dbg_launcher.dbg-phys-small .dbg-hud { font-size: 11px; padding: 6px 9px; min-width: 128px; line-height: 1.5; }
      #__dbg_launcher.dbg-phys-small .dbg-hud-path { max-width: 46vw; }
      /* Wrap toolbar buttons on small screens (keep the rightmost ✓ confirm visible): dbg-phys-small (device <768) forces wrap,
         not relying on dbg-compact (subject to isSmallScreen/isTouchCompact; may never trigger on real devices) */
      #__dbg_launcher.dbg-phys-small .dbg-toolbar-btns { flex-wrap: wrap; }
      /* Small-screen dialog (confirm/preview dialog) and speed (throttle/network/errors): enlarge fonts/icons (responsive, per the AI window; 14px baseline) */
      #__dbg_launcher.dbg-phys-small .dbg-dialog { font-size: 14px; }
      #__dbg_launcher.dbg-phys-small .dbg-dialog-head { padding: 14px 16px; }
      #__dbg_launcher.dbg-phys-small .dbg-dialog-head code { font-size: 13px; }
      #__dbg_launcher.dbg-phys-small .dbg-dialog-head .dbg-loc { font-size: 13px; }
      #__dbg_launcher.dbg-phys-small .dbg-dialog-head button { min-width: 40px; min-height: 40px; font-size: 17px; }
      #__dbg_launcher.dbg-phys-small .dbg-dialog-body { padding: 14px 16px; }
      #__dbg_launcher.dbg-phys-small .dbg-dialog-body textarea { min-height: 80px; font-size: 14px; }
      #__dbg_launcher.dbg-phys-small .dbg-dialog-foot { padding: 12px 16px; }
      #__dbg_launcher.dbg-phys-small .dbg-dialog-foot button { min-height: 44px; font-size: 15px; padding: 9px 18px; }
      #__dbg_launcher.dbg-phys-small .dbg-preview { font-size: 13px; padding: 10px 12px; }
      #__dbg_launcher.dbg-phys-small .dbg-checks label { font-size: 13px; padding: 6px 10px; }
      #__dbg_launcher.dbg-phys-small .dbg-speed { font-size: 14px; }
      #__dbg_launcher.dbg-phys-small .dbg-speed-head { padding: 12px 14px; }
      #__dbg_launcher.dbg-phys-small .dbg-speed-head button { min-width: 40px; min-height: 40px; font-size: 17px; }
      #__dbg_launcher.dbg-phys-small .dbg-speed-body { padding: 12px 14px; }
      #__dbg_launcher.dbg-phys-small .dbg-seg button { min-height: 36px; font-size: 14px; padding: 5px 12px; }
      #__dbg_launcher.dbg-phys-small .dbg-chk { font-size: 13px; padding: 6px 10px; }
      #__dbg_launcher.dbg-phys-small .dbg-speed-row > label:first-child { min-width: 72px; }
      .dbg-hud b { color: #fff; }
      .dbg-hud i { color: #93c5fd; font-style: normal; }
      .dbg-hud .dbg-hud-path { color: #94a3b8; word-break: break-all; }
      /* HUD body is pointer-events:none (does not intercept page interaction -- elements under a covered popup menu stay hoverable/clickable);
         the top-right grip is the only drag handle; .dbg-open-file links are individually allowed through as clickable */
      .dbg-hud .dbg-hud-grip {
        position: absolute; top: 2px; right: 4px; z-index: 2;
        font-size: 10px; line-height: 1; color: #64748b; cursor: grab; user-select: none;
        padding: 1px 2px; pointer-events: auto;
        touch-action: none; -webkit-user-select: none; /* touch drag: stop the browser treating gestures as scroll (otherwise pointercancel → drag aborted) */
      }
      .dbg-hud .dbg-hud-grip:hover { color: #c7d2fe; }
      /* pick HUD action row: when content overflows and scrolls, buttons stay stuck to the bottom and visible (background covers the HUD bottom edge, no visual seams) */
      .dbg-hud .dbg-hud-actions {
        position: sticky; bottom: 0; margin-top: 6px; margin-left: -12px; margin-right: -12px;
        padding: 3px 12px 7px; background: rgba(17,24,39,.94); border-radius: 0 0 10px 10px;
      }
      #__dbg_launcher.dbg-phys-small .dbg-hud .dbg-hud-actions {
        margin-left: -9px; margin-right: -9px; padding: 3px 9px 6px;
      }
      /* Toolbar simulated-hover button (dispatches real events): highlighted while on */
      .dbg-toolbar .dbg-nav-hover { background: #ccfbf1; color: #0f766e; }
      .dbg-toolbar .dbg-nav-hover.dbg-on, .dbg-toolbar .dbg-nav-hover.dbg-on:hover { background: #0f766e; color: #fff; box-shadow: inset 0 0 0 1px rgba(204,251,241,.5); }
      /* Arrow points at the selection (default position: below the selection, arrow pointing up at it) */
      .dbg-hud::before {
        content: ''; position: absolute; top: -8px; left: 18px;
        width: 0; height: 0; border-left: 8px solid transparent; border-right: 8px solid transparent;
        border-bottom: 8px solid rgba(17,24,39,.94);
      }
      /* Flipped above the selection: arrow at the bottom points at the selection */
      .dbg-hud.dbg-hud-up::before {
        top: auto; bottom: -8px;
        border-bottom: 0; border-top: 8px solid rgba(17,24,39,.94);
      }
      .dbg-hud b { color: #fff; }
      .dbg-hud i { color: #93c5fd; font-style: normal; }
      .dbg-hud .dbg-hud-path { color: #94a3b8; }
      .dbg-tooltip {
        position: fixed; z-index: 2147483648; background: rgba(17,24,39,.94); color: #e5e7eb; /* same style as the hover popup: dark/rounded/multiline */
        font-size: 11px; line-height: 1.65; padding: 7px 12px; border-radius: 10px; max-width: min(340px, 90vw);
        transition: opacity .3s; pointer-events: none; opacity: 0; box-shadow: 0 6px 20px rgba(0,0,0,.4);
      }
      @media (max-width: 768px), (pointer: coarse) { .dbg-tooltip { font-size: 14px; padding: 9px 14px; } }
      /* Event-interception tip bar (bottom/top toast, dodging the mouse): pure information display, pointer-events always off -- never swallows clicks on elements below;
         vertical position is written inline top/bottom by showBlockedTip based on the half-screen where the intercept happened (lower half → shown in upper half); this is only the creation-time fallback */
      .dbg-block-tip {
        position: fixed; left: 50%; bottom: 10px; transform: translateX(-50%);
        z-index: 2147483648; background: rgba(15,23,42,.95); color: #fde68a;
        border: 1px solid rgba(253,230,138,.45); border-radius: 999px;
        padding: 7px 16px; font-size: 12px; line-height: 1.5;
        box-shadow: 0 6px 20px rgba(0,0,0,.35); opacity: 0; pointer-events: none;
        transition: opacity .25s; max-width: 92vw; white-space: nowrap;
        overflow: hidden; text-overflow: ellipsis;
      }
      .dbg-block-tip b { color: #fff; }
      .dbg-profile-menu {
        position: fixed; z-index: 2147483647; min-width: 220px; background: #fff; /* topmost layer (same tier as the toolbar, later-created renders on top): dropdown not covered by the toolbar */
        border: 1px solid rgba(0,0,0,.15); border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.2);
        padding: 4px; font-size: 12px;
      }
      .dbg-profile-item { display: flex; justify-content: space-between; gap: 8px; align-items: center; padding: 6px 10px; border-radius: 7px; cursor: pointer; }
      .dbg-profile-item:hover { background: #eef2ff; }
      .dbg-profile-item.dbg-on { background: #e0e7ff; font-weight: 600; }
      /* Allow-scheme dropdown: persistent action item "⚙️ Custom…" + divider */
      .dbg-profile-divider { height: 1px; background: #e2e8f0; margin: 3px 4px; }
      .dbg-profile-item.dbg-profile-action { color: #4338ca; }
      .dbg-profile-item.dbg-profile-action:hover { background: #eef2ff; }
      .dbg-profile-label { font-weight: 600; }
      .dbg-profile-desc { font-size: 10px; color: #6b7280; }
      /* Small screen: allow-scheme dropdown font scales with the menu (was fixed 12px/10px) */
      #__dbg_launcher.dbg-phys-small .dbg-profile-menu { font-size: 13px; min-width: 250px; }
      #__dbg_launcher.dbg-phys-small .dbg-profile-item { padding: 8px 11px; }
      #__dbg_launcher.dbg-phys-small .dbg-profile-desc { font-size: 11px; }
      /* ❓ Help window (help subsystem): bottom-centered floating layer, scrollable, draggable by its head; z-index 2147483648 covers the toolbar */
      .dbg-help-dialog { position: fixed; z-index: 2147483648; background: #fff; border-radius: 12px;
        box-shadow: 0 10px 30px rgba(0,0,0,.25); max-height: 70vh;
        display: flex; flex-direction: column; font-size: 11px; color: #334155; overflow: hidden; }
      .dbg-help-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 12px;
        background: #eef2ff; color: #3730a3; font-weight: 600; cursor: grab; user-select: none; -webkit-user-select: none; flex: none; touch-action: none; }
      .dbg-help-dialog.dbg-dragging .dbg-help-head { cursor: grabbing; }
      .dbg-help-head button { border: 0; background: none; cursor: pointer; font-size: 14px; color: #64748b; min-width: 26px; height: 26px; }
      .dbg-help-body { padding: 10px 12px; overflow-y: auto; line-height: 1.7; }
      .dbg-help-body h4 { margin: 9px 0 3px; font-size: 11px; color: #3730a3; }
      .dbg-help-body h4:first-child { margin-top: 0; }
      .dbg-help-body code { background: #f1f5f9; border-radius: 4px; padding: 0 4px; font-size: 10px; }
      .dbg-help-body table { border-collapse: collapse; margin: 3px 0; max-width: 100%; }
      .dbg-help-body td { border: 1px solid #e2e8f0; padding: 2px 7px; vertical-align: top; }
      .dbg-help-body kbd { background: #f1f5f9; border: 1px solid #cbd5e1; border-bottom-width: 2px; border-radius: 4px;
        padding: 0 4px; font-family: inherit; font-size: 10px; white-space: nowrap; }
      .dbg-help-note { font-size: 10px; color: #94a3b8; margin-top: 2px; }
      .dbg-help-nav-row button { margin: 3px 6px 3px 0; border: 1px solid #c7d2fe; background: #eef2ff;
        border-radius: 6px; padding: 4px 10px; cursor: pointer; font: inherit; color: #4338ca; }
      .dbg-help-nav-row button:active { background: #e0e7ff; }
      #__dbg_launcher.dbg-phys-small .dbg-help-dialog { font-size: 13px; max-height: 78vh; border-radius: 14px; }
      #__dbg_launcher.dbg-phys-small .dbg-help-body td { padding: 5px 9px; }
      #__dbg_launcher.dbg-phys-small .dbg-help-body kbd { font-size: 12px; padding: 1px 6px; }
      #__dbg_launcher.dbg-phys-small .dbg-help-nav-row button { padding: 10px 14px; } /* 44px touch target */
      .dbg-toolbar .dbg-sel-label { color: #4f46e5; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: min(60vw, 360px); word-break: break-all; overflow-wrap: anywhere; }
      .dbg-toolbar button {
        border: 1px solid #c7d2fe; background: #fff; border-radius: 8px; padding: 2px 8px;
        cursor: pointer; font: inherit; color: #3730a3;
      }
      .dbg-toolbar button:hover { background: #e0e7ff; }
      .dbg-toolbar .dbg-spacer { flex: 1; }
      .dbg-panel {
        position: fixed; right: 18px; bottom: 76px; z-index: 2147483641;
        width: 360px; background: #fff; border: 1px solid rgba(0,0,0,.15); border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,.25); display: none; flex-direction: column;
      }
      .dbg-panel.dbg-open { display: flex; }
      .dbg-panel-head { padding: 10px 12px; font-weight: 600; border-bottom: 1px solid #e5e7eb; display: flex; justify-content: space-between; }
      .dbg-panel-head button { border: 0; background: none; cursor: pointer; font-size: 13px; color: #6b7280; }
      .dbg-msgs { height: 260px; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
      .dbg-msg { max-width: 85%; padding: 7px 10px; border-radius: 10px; white-space: pre-wrap; word-break: break-word; }
      .dbg-msg.user { align-self: flex-end; background: ${accent}; color: #fff; }
      .dbg-msg.ai { align-self: flex-start; background: #f3f4f6; }
      .dbg-msg.sys { align-self: center; font-size: 11px; color: #9ca3af; }
      .dbg-input-row { display: flex; gap: 6px; padding: 8px; border-top: 1px solid #e5e7eb; }
      .dbg-input-row input { flex: 1; border: 1px solid #d1d5db; border-radius: 8px; padding: 7px 9px; font: inherit; }
      .dbg-input-row button { border: 0; border-radius: 8px; padding: 7px 12px; background: ${accent}; color: #fff; cursor: pointer; font: inherit; }
      /* ---- AI floating window (draggable / dock-to-edge / resizable width-height) ---- */
      .dbg-ai-win {
        position: fixed; z-index: 2147483642; display: none;
        background: #fff; border: 1px solid rgba(0,0,0,.18); border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,.25); overflow: hidden;
        min-width: 280px; min-height: 200px;
      }
      .dbg-ai-win.dbg-dragging { opacity: .85; cursor: grabbing; }
      .dbg-ai-bar {
        height: 30px; display: flex; align-items: center; gap: 3px;
        padding: 0 8px; background: #f9fafb; border-bottom: 1px solid #e5e7eb;
        font-size: 12px; cursor: grab; user-select: none; -webkit-user-select: none;
        touch-action: none; /* touch drag: stop the browser treating gestures as scroll (otherwise pointercancel → drag aborted; observed stuck on pads; pointerdown preventDefault cannot stop touch scrolling) */
        -webkit-touch-callout: none; /* no iOS long-press system menu */
        position: relative; z-index: 3; /* covers the resize handle (z2): the right-edge drag strip (.dbg-ai-resize-r, 14px) overlaps the close button → clicking close starts a drag (user-observed) */
      }
      .dbg-ai-bar .dbg-ai-title { font-weight: 600; margin-right: auto; color: #374151; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 38vw; flex-shrink: 1; display: flex; align-items: center; gap: 5px; }
      .dbg-ai-bar .dbg-ai-favicon { width: 14px; height: 14px; border-radius: 3px; flex-shrink: 0; }
      .dbg-ai-bar button {
        border: 1px solid #d1d5db; background: #fff;
        padding: 0; width: 26px; height: 26px; border-radius: 50%;
        cursor: pointer; font: inherit; font-size: 11px; color: #4b5563;
      } /* icon buttons (maximize/new window/settings/close) are perfect circles */
      .dbg-ai-bar button:hover { background: #eef2ff; border-color: #c7d2fe; }
      .dbg-ai-bar .dbg-ai-close { color: #dc2626; }
      /* Small screen: simplified AI window title bar -- defaults to fullscreen docked (maximized), with only maximize/new window/settings/close */
      #__dbg_launcher.dbg-phys-small .dbg-ai-bar { height: 34px; padding: 0 6px; font-size: 12px; gap: 4px; }
      #__dbg_launcher.dbg-phys-small .dbg-ai-bar .dbg-ai-title { font-size: 12px; }
      #__dbg_launcher.dbg-phys-small .dbg-ai-bar button { min-width: 26px; min-height: 26px; font-size: 12px; padding: 1px 5px; }
      /* Group spacing: whitespace before the right fixed group (⛶⧉⚙✕) (no longer clumped together, harder to mis-tap on touch) */
      #__dbg_launcher.dbg-phys-small .dbg-ai-bar .dbg-ai-max { margin-left: 10px; }
      #__dbg_launcher.dbg-phys-small .dbg-ai-bar .dbg-ai-pop { margin-left: 10px; }
      #__dbg_launcher.dbg-phys-small .dbg-ai-resize { display: none; } /* small screen is full-width docked with self-fitting size, no corner handle */
      /* Small screen: resize edge strips (right/bottom/left) hidden -- small-screen gestures are already disabled via filter:!small (cannot drag),
         yet the strips still cover the matching iframe edges (bottom 24px hit zone blocks content clicks, clicks do nothing) → pure occlusion; hiding frees the edge */
      #__dbg_launcher.dbg-phys-small .dbg-ai-resize-r,
      #__dbg_launcher.dbg-phys-small .dbg-ai-resize-b,
      #__dbg_launcher.dbg-phys-small .dbg-ai-resize-l { display: none; }
      #__dbg_launcher.dbg-phys-small .dbg-ai-win iframe { height: calc(100% - 34px) !important; }
      .dbg-ai-resize {
        position: absolute; right: 0; bottom: 0; width: 20px; height: 20px;
        cursor: nwse-resize; z-index: 2;
        touch-action: none; -webkit-user-select: none; /* touch resize handle same as the drag strip: disable browser scroll gestures */
      }
      /* Left-edge strip (mirror of the right edge): single-axis width resize (left edge follows the pointer, right edge anchored) -- kept on small screens too (user-observed: the bottom-left corner was not draggable, only right/bottom had edge strips) */
      .dbg-ai-resize-l {
        position: absolute; left: 0; top: 0; width: 14px; height: 100%;
        cursor: ew-resize; z-index: 2; touch-action: none; -webkit-user-select: none;
      }
      /* Edge strips (right/bottom): single-axis width/height resize -- on touch the bottom-right corner handle requires diagonal dragging and, when docked to the screen bottom, lands in the system gesture area,
         hard to use with a real finger; edge strips are long and easy to hit. Transparent by default; hover/touch widens the hit zone (44px) with a visible hint */
      .dbg-ai-resize-r {
        position: absolute; right: 0; top: 0; width: 14px; height: 100%;
        cursor: ew-resize; z-index: 2; touch-action: none; -webkit-user-select: none;
      }
      .dbg-ai-resize-b {
        position: absolute; left: 0; bottom: 0; width: 100%; height: 14px;
        cursor: ns-resize; z-index: 2; touch-action: none; -webkit-user-select: none;
      }
      .dbg-ai-resize-r::after, .dbg-ai-resize-b::after, .dbg-ai-resize-l::after {
        content: ''; position: absolute; border-radius: 3px; background: transparent; transition: background .15s;
      }
      .dbg-ai-resize-r::after { right: 3px; top: 25%; bottom: 25%; width: 4px; }
      .dbg-ai-resize-l::after { left: 3px; top: 25%; bottom: 25%; width: 4px; }
      .dbg-ai-resize-b::after { bottom: 3px; left: 25%; right: 25%; height: 4px; }
      /* Light up only when hovering the indicator strip itself (old .dbg-ai-win:hover lit up anywhere in the window → looked "always on", more obvious with touch sticky-hover);
         the hint appears only when actually about to drag there (pointer over the edge strip) */
      .dbg-ai-resize-r:hover::after, .dbg-ai-resize-b:hover::after, .dbg-ai-resize-l:hover::after { background: rgba(99,102,241,.35); }
      /* Lit only while resizing (touch included -- replaces the old "always visible on touch" scheme: always-on is visual noise, feedback when in use is enough):
         the dbg-resizing class is added/removed by the gesture layer (added on drag start, removed on end) */
      .dbg-ai-win.dbg-resizing .dbg-ai-resize-r::after, .dbg-ai-win.dbg-resizing .dbg-ai-resize-b::after, .dbg-ai-win.dbg-resizing .dbg-ai-resize-l::after, .dbg-ai-win.dbg-resizing .dbg-ai-resize::after { background: rgba(99,102,241,.6); }
      /* Bottom-right L handle: hidden by default, lit on hover (consistent with the edge strips -- always-on is visual noise) */
      .dbg-ai-resize::after {
        content: ''; position: absolute; right: 3px; bottom: 3px;
        width: 8px; height: 8px; border-right: 2px solid transparent; border-bottom: 2px solid transparent;
        border-radius: 2px; transition: border-color .15s;
      }
      .dbg-ai-resize:hover::after { border-color: rgba(99,102,241,.6); }
      /* ---- ⧉ New-window layout dropdown (Chrome Inspector style: separate popup / side-by-side split / top-bottom split) ---- */
      .dbg-ai-pop-menu {
        position: fixed; z-index: 2147483647; min-width: 200px;
        background: #fff; border: 1px solid rgba(0,0,0,.15); border-radius: 10px;
        box-shadow: 0 8px 32px rgba(0,0,0,.25); padding: 4px; font-size: 12px;
      }
      .dbg-ai-pop-menu-item { display: flex; flex-direction: column; gap: 1px; padding: 6px 10px; border-radius: 7px; cursor: pointer; color: #374151; }
      .dbg-ai-pop-menu-item:hover { background: #eef2ff; }
      .dbg-ai-pop-menu-item.dbg-on { background: #4f46e5; color: #fff; }
      .dbg-ai-pop-menu-desc { font-size: 10px; opacity: .72; }
      /* ---- Throttle/intercept panel ---- */
      .dbg-speed {
        position: fixed; right: 18px; bottom: 76px; z-index: 2147483643;
        width: 340px; max-height: calc(100vh - 96px); overflow-y: auto;
        background: #fff; border: 1px solid rgba(0,0,0,.15); border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,.25); display: none; font-size: 12px;
      }
      .dbg-speed.dbg-open { display: block; }
      .dbg-speed-head { position: sticky; top: 0; background: #fff; z-index: 1; }
      .dbg-speed-head {
        display: flex; justify-content: space-between; align-items: center;
        padding: 8px 12px; font-weight: 600; border-bottom: 1px solid #e5e7eb;
      }
      .dbg-speed-head button { border: 0; background: none; cursor: pointer; color: #6b7280; font-size: 13px; }
      .dbg-speed-body { padding: 10px 12px; display: flex; flex-direction: column; gap: 10px; }
      .dbg-speed-row { display: flex; align-items: center; gap: 8px; }
      .dbg-speed-row > label:first-child { min-width: 64px; font-weight: 600; color: #374151; }
      .dbg-seg { display: flex; gap: 4px; flex-wrap: wrap; }
      .dbg-seg button {
        border: 1px solid #d1d5db; background: #fff; border-radius: 6px;
        padding: 2px 8px; cursor: pointer; font: inherit; font-size: 11px; color: #4b5563;
      }
      .dbg-seg button.dbg-on { background: ${accent}; color: #fff; border-color: ${accent}; }
      .dbg-chk { display: flex; align-items: center; gap: 4px; background: #f3f4f6; border-radius: 6px; padding: 3px 8px; cursor: pointer; font-size: 11px; }
      .dbg-release-row { align-items: flex-start; }
      .dbg-release-row > label:first-child { padding-top: 3px; }
      .dbg-rel-wrap { display: flex; flex-direction: column; gap: 4px; flex: 1; }
      /* ---- Dangerous-command confirm card ---- */
      /* AI window settings popup (⚙): small screen height % + docked / large screen width-height + position; z above the AI window (2147483642) -- not occluded by it; light theme consistent with launcher dialogs */
      .dbg-ai-settings-pop {
        position: fixed; z-index: 2147483647; background: #fff; color: #111827;
        border-radius: 12px; padding: 10px 12px; font-size: 12px; min-width: 210px;
        box-shadow: 0 10px 40px rgba(0,0,0,.25); border: 1px solid #e5e7eb;
      }
      .dbg-confirm-card { max-width: 380px; }
      .dbg-confirm-note { font-size: 13px; font-weight: 600; color: #b45309; }
      .dbg-confirm-cmd { font-family: ui-monospace, monospace; font-size: 11px; padding: 6px 8px; word-break: break-all; }
      .dbg-confirm-countdown { font-size: 11px; color: #d97706; background: rgba(217,119,6,.12); border-radius: 6px; padding: 4px 8px; line-height: 1.5; }
      .dbg-dialog {
        position: fixed; inset: 0; z-index: 2147483645; display: none;
        background: rgba(17,24,39,.45); align-items: center; justify-content: center;
      }
      /* Pick/ask/notify panels (aiti-user-*): bottom-right floating layer -- no fullscreen cover, draggable and minimizable;
       * width is taken over inline at runtime by placePhysPanel (ask panel 520, small screen auto w-24); the CSS value only applies for the instant before mount */
      .dbg-pick-dialog {
        position: fixed; right: 12px; bottom: 12px; z-index: 2147483646; width: 520px; max-width: 92vw;
        background: linear-gradient(180deg, rgba(30,41,59,.98), rgba(17,24,39,.98)); color: #e5e7eb; border-radius: 14px;
        border: 1px solid rgba(148,163,184,.22);
        box-shadow: 0 12px 40px rgba(0,0,0,.5); font-size: 14px; overflow: hidden;
      }
      /* Transient toast: notifies the user when an interaction arrives, auto-dismisses after a few seconds -- non-blocking, no confirm dialog */
      .dbg-pick-toast {
        position: fixed; z-index: 2147483648; background: rgba(17,24,39,.95); color: #e5e7eb;
        border-radius: 10px; padding: 8px 12px; font-size: 12px; line-height: 1.6;
        box-shadow: 0 8px 30px rgba(0,0,0,.4); text-align: center; pointer-events: none;
        transition: opacity .4s; word-break: break-all;
      }
      .dbg-pick-head { padding: 10px 14px; font-weight: 600; font-size: 14px; display: flex; align-items: center; gap: 8px; cursor: grab; touch-action: none; background: rgba(255,255,255,.045); border-bottom: 1px solid rgba(148,163,184,.16); } /* cursor grab + touch-action:none: draggable head (makePointerDrag, same as the AI window) */
      .dbg-pick-dialog.dbg-dragging { cursor: grabbing; opacity: .92; box-shadow: 0 14px 44px rgba(0,0,0,.55); }
      .dbg-pick-head .dbg-pick-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dbg-pick-head button { border: 1px solid transparent; background: rgba(255,255,255,.12); color: #e5e7eb; border-radius: 6px; padding: 3px 10px; cursor: pointer; font: inherit; font-size: 13px; }
      .dbg-pick-head button:hover { background: rgba(255,255,255,.2); }
      .dbg-pick-body { padding: 14px; font-size: 14px; color: #d3d9e0; line-height: 1.6; }
      .dbg-pick-body input::placeholder { color: #64748b; }
      .dbg-pick-body .dbg-pick-sel { margin: 6px 0; font-size: 14px; color: #93c5fd; word-break: break-all; }
      .dbg-pick-body button { border: 0; border-radius: 7px; padding: 9px 14px; cursor: pointer; font: inherit; font-size: 15px; }
      /* ---- Ask panel (aiti-user-*) visual contract (2026-09 polish: readability/colors/width/numbering/small screen) ----
       * Question area (.dbg-ask-prompt): large high-contrast font + left accent bar -- the AI's question is the panel's most important information
       * Options area: vertical full-width list (long copy wraps without squeezing) + number badges (1/2/3…, matching keyboard shortcuts 1-9)
       * Semantic colors: primary action (yes/confirm/I'm here) green gradient; negative/cancel red text with light-red hover; "none of these fit" dashed gray */
      .dbg-ask-prompt { white-space: pre-wrap; font-size: 15px; font-weight: 600; color: #f8fafc; line-height: 1.7; word-break: break-word; background: rgba(96,165,250,.08); border-left: 3px solid #60a5fa; border-radius: 6px; padding: 10px 74px 10px 12px; margin-bottom: 10px; }
      /* Copyable message areas (user-select: text); one-click copy lives in the panel header
       * (lucide copy button, same as the notify card) -- no floating body button anymore.
       * .dbg-copyable .dbg-msg-copy CSS removed with it (keys stay in locales: aiwin/debug still use them). */
      .dbg-copyable { position: relative; user-select: text; -webkit-user-select: text; }
      .dbg-notify-body { white-space: pre-wrap; font-size: 14px; line-height: 1.7; color: #e5e7eb; word-break: break-word; overflow-wrap: anywhere; user-select: text; -webkit-user-select: text; }
      .dbg-pick-body .dbg-ask-opt { display: flex; align-items: center; gap: 9px; width: 100%; min-width: 0; justify-content: flex-start; text-align: left; padding: 10px 12px; border-radius: 9px; background: rgba(255,255,255,.07); border: 1px solid rgba(148,163,184,.28); color: #eef2f7; transition: background .12s, border-color .12s; }
      .dbg-pick-body .dbg-ask-opt:hover { background: rgba(255,255,255,.13); border-color: rgba(165,180,252,.6); }
      .dbg-ask-num { flex: 0 0 auto; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 6px; background: rgba(99,102,241,.22); border: 1px solid rgba(129,140,248,.5); color: #c7d2fe; font-size: 12px; font-weight: 700; line-height: 1; display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; }
      .dbg-pick-body .dbg-ask-opt.dbg-primary { background: linear-gradient(135deg, #22c55e, #16a34a); border-color: transparent; color: #fff; font-weight: 700; box-shadow: 0 2px 12px rgba(34,197,94,.35); }
      .dbg-pick-body .dbg-ask-opt.dbg-primary:hover { background: linear-gradient(135deg, #16a34a, #15803d); }
      .dbg-ask-opt.dbg-primary .dbg-ask-num { background: rgba(255,255,255,.22); border-color: rgba(255,255,255,.5); color: #fff; }
      .dbg-pick-body .dbg-ask-opt.dbg-ask-no { color: #fca5a5; }
      .dbg-pick-body .dbg-ask-opt.dbg-ask-no:hover { background: rgba(248,113,113,.12); border-color: rgba(248,113,113,.55); }
      .dbg-pick-body .dbg-ask-opt.dbg-ask-opt-custom { border-style: dashed; color: #c3cad4; }
      .dbg-ask-opt.dbg-on { outline: 2px solid #a5b4fc; outline-offset: 1px; }
      .dbg-pick-body .dbg-ask-opt.dbg-on.dbg-primary { background: linear-gradient(135deg, #16a34a, #15803d); }
      .dbg-ask-label { display: block; font-size: 13px; color: #94a3b8; margin-top: 10px; }
      /* "Can't handle right now" reject-area button (inline styles consolidated into CSS: unified across panels) */
      .dbg-ask-reject { font-size: 13px; padding: 8px 12px; background: rgba(255,255,255,.06); border: 1px solid rgba(148,163,184,.3); color: #e5e7eb; border-radius: 8px; cursor: pointer; }
      .dbg-ask-reject:hover { background: rgba(255,255,255,.13); }
      .dbg-pick-ok { background: #4f46e5; color: #fff; }
      .dbg-pick-cancel { background: rgba(255,255,255,.12); color: #e5e7eb; margin-right: 6px; }
      /* Ask panel send button (free-text input / multi-select send): bright green highlight -- previously transparent with no fill, nearly invisible on the dark panel (user-observed) */
      .dbg-pick-body .dbg-ask-send {
        background: linear-gradient(135deg, #22c55e, #16a34a); color: #fff; font-weight: 700; border: 0;
        box-shadow: 0 2px 12px rgba(34,197,94,.45), inset 0 1px 0 rgba(255,255,255,.25);
        text-shadow: 0 1px 2px rgba(0,0,0,.3);
      }
      .dbg-pick-body .dbg-ask-send:hover { background: linear-gradient(135deg, #16a34a, #15803d); }
      .dbg-pick-body .dbg-ask-send:disabled { opacity: .4; box-shadow: none; }
      .dbg-pick-result { background: rgba(79,70,229,.15); border-radius: 8px; padding: 6px 8px; margin-top: 6px; font-size: 11px; word-break: break-all; }
      .dbg-dialog.dbg-open { display: flex; }
      .dbg-dialog-card { width: min(460px, 90vw); max-height: 82vh; overflow: auto; background: #fff; border-radius: 14px; box-shadow: 0 20px 60px rgba(0,0,0,.35); }
      .dbg-dialog-head { padding: 12px 14px; font-weight: 600; border-bottom: 1px solid #e5e7eb; display: flex; justify-content: space-between; align-items: center; gap: 8px; cursor: grab; touch-action: none; } /* cursor grab + touch-action:none: draggable head (makeCardDrag) */
      .dbg-dialog-card.dbg-dragging { cursor: grabbing; opacity: .95; box-shadow: 0 24px 70px rgba(0,0,0,.4); }
      .dbg-dialog-head code { font-size: 11px; color: ${accent}; background: ${accent}18; padding: 2px 6px; border-radius: 6px; }
      .dbg-dialog-head .dbg-loc { font-size: 11px; color: #6b7280; font-weight: 400; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dbg-dialog-body { padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
      /* ---- Preview UI ---- */
      .dbg-preview { border: 1px solid #e5e7eb; border-radius: 8px; background: #f9fafb; padding: 8px 10px; font-size: 11px; }
      .dbg-preview .dbg-pv-row { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 4px; }
      .dbg-preview .dbg-pv-row:last-child { margin-bottom: 0; }
      .dbg-preview b { color: #374151; }
      .dbg-preview .dbg-pv-kv { color: #6b7280; background: #fff; border: 1px solid #e5e7eb; border-radius: 4px; padding: 1px 5px; }
      .dbg-preview .dbg-pv-file { color: #059669; word-break: break-all; }
      /* Row copy button: shown on hover (📋) -- when Clipboard fails inside an iframe, forwards to the host via the dbg_copy protocol */
      .dbg-preview .dbg-pv-copy { opacity: 0; transition: opacity .15s; margin-left: 4px; padding: 0 6px; font-size: 10px; cursor: pointer; border: 1px solid #d1d5db; border-radius: 4px; background: #fff; color: #374151; vertical-align: middle; }
      .dbg-preview .dbg-pv-row:hover .dbg-pv-copy { opacity: 1; }
      /* File-row action buttons (📂 backend / 🖥 frontend): also shown only on hover, avoiding a cluttered default look that hurts readability */
      .dbg-preview .dbg-mini-open { opacity: 0; transition: opacity .15s; vertical-align: middle; }
      .dbg-preview .dbg-pv-row:hover .dbg-mini-open { opacity: 1; }
      .dbg-open-file { color: #2563eb; text-decoration: underline; cursor: pointer; pointer-events: auto; }
      .dbg-open-file:hover { color: #1d4ed8; }
      .dbg-checks { display: flex; flex-wrap: wrap; gap: 6px; }
      .dbg-checks label { display: flex; align-items: center; gap: 4px; font-size: 12px; background: #f3f4f6; border-radius: 6px; padding: 4px 8px; cursor: pointer; }
      .dbg-dialog-body textarea { min-height: 60px; border: 1px solid #d1d5db; border-radius: 8px; padding: 8px; font: inherit; resize: vertical; }
      .dbg-dialog-foot { padding: 10px 14px; border-top: 1px solid #e5e7eb; display: flex; justify-content: flex-end; gap: 8px; }
      .dbg-dialog-foot button { border-radius: 8px; padding: 7px 14px; cursor: pointer; font: inherit; }
      .dbg-dialog-foot .dbg-primary { background: ${accent}; color: #fff; border: 0; }
      .dbg-dialog-foot .dbg-ghost { background: #fff; border: 1px solid #d1d5db; }
      /* ---- Debug info window (replaces transient toast) + settings popup ---- */
      .dbg-overlay { position: fixed; inset: 0; z-index: 2147483644; background: rgba(17,24,39,0); display: none; } /* mask made transparent: does not cover the page (users mistook it for a 'pale blue full-window mask') -- clicking blank space outside the card closes it */
      .dbg-overlay.dbg-open { display: block; }
      .dbg-overlay-card { position: fixed; top: 0; left: 0; background: #fff; border-radius: 14px; box-shadow: 0 20px 60px rgba(0,0,0,.4); max-width: 92vw; display: flex; flex-direction: column; }
      .dbg-overlay-card .dbg-dialog-body { flex: 1 1 auto; overflow: auto; min-height: 0; } /* head/foot fixed, middle scrolls -- bottom buttons always visible */
      .dbg-debug-info { font: 11px/1.6 ui-monospace,monospace; white-space: pre-wrap; word-break: break-all; background: #0f172a; color: #e5e7eb; border-radius: 8px; padding: 10px 12px; }
      .dbg-debug-help { font-size: 12px; color: #4b5563; line-height: 1.85; }
      .dbg-debug-help b { color: #111827; display: block; margin-bottom: 4px; }
      .dbg-debug-help code { background: #f3f4f6; padding: 1px 5px; border-radius: 4px; font: 11px ui-monospace,monospace; color: #374151; }
      .dbg-settings { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.2); display: flex; flex-direction: column; gap: 8px; min-width: 200px; }
      .dbg-settings label { display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; }
      .dbg-settings button { border: 1px solid #d1d5db; background: #fff; border-radius: 6px; padding: 6px 10px; cursor: pointer; font: inherit; font-size: 12px; }
      .dbg-settings button:hover { background: #f9fafb; }
      /* Hover debug panel (whether hover is suppressed after clicking inspect/HUD; copyable to paste to the AI) */

      /* ===== Small-screen adaptation (whether the host page adapts is not our concern; we adapt our own UI) ===== */
      /* Small-screen detection adds the class by device physical size (screen.width) -- not the layout viewport (mobile layout=980 misdetects); not the visual viewport either (user zoom changes it → small screens misdetect as large) */
      .dbg-fab.dbg-smal button { width: 46px; height: 46px; font-size: 12px; }
      .dbg-fab.dbg-tiny button { width: 48px; height: 48px; font-size: 13px; }
      /* Small screen: selected (dbg-on) AI/inspect buttons show no solid square background -- a solid accent fill on a pill/round button looks like a square.
         Transparent background + accent outline + icon is enough to distinguish, no square look */
      #__dbg_launcher.dbg-phys-small .dbg-fab button.dbg-on { background: transparent !important; background-color: transparent !important; box-shadow: inset 0 0 0 2px ${accent}; }
      /* Touch or narrow viewport <768: AI window size is already precisely controlled by JS placePhysBox (capVisW/capVisH),
         only bar/panel visual sizes remain here -- remove .dbg-ai-win's !important width/height (conflicts with placePhysBox:
         pointer:coarse on meta-less touch pages 100vw=980 → width 960 overflows the screen; on responsive pages 78vh/100vw heights are wrong too) */
      /* Enlarge button sizes only for narrow viewport <768 -- user-observed: a wide touch screen (777px) hitting the pointer:coarse tier made title bar icons oversized (fine on first load, grew later),
         so trigger by width only; resize handles still go through @media (pointer: coarse) separately (see below) */
      @media (max-width: 767px) {
        .dbg-ai-bar { height: 32px; }
        .dbg-ai-bar button { min-width: 28px; min-height: 28px; font-size: 14px; }
        .dbg-ai-bar .dbg-ai-title { font-size: 12px; }
        .dbg-speed { right: 10px; width: calc(100vw - 20px); max-height: calc(100vh - 90px); }
        .dbg-panel { right: 10px; width: calc(100vw - 20px); }
      }
      /* Touch or <480: maximum touch sizes */
      @media (max-width: 479px) {
        /* Narrow phones only: 32px touch buttons; wide touch screens (tablets/large touch) use the previous tier 28px -- user-observed 38/32px too large (title bar icons felt oversized) */
        .dbg-ai-bar button { min-width: 32px; min-height: 32px; font-size: 15px; }
      }
      @media (pointer: coarse) {
        /* Resize handle/edge strips: hit zone enlarged to the touch standard (visual marker unchanged, ::after anchored in the corner) --
           otherwise fingers cannot press the tiny corner (presses land outside the window/on the iframe), unusable on touch;
           the visual hint is no longer always visible (old scheme) -- lit only while resizing (.dbg-resizing, see above), invisible otherwise */
        /* Corner handle hot zone moved 10px inward from the corner: when the window docks to the screen edge (full-width/docked) the handle sits on the screen corner -- the Android system gesture area
           (back-swipe vertical edge + home horizontal bar), where a real finger touching it gets the gesture stolen by the system (pointercancel ends the drag early,
           observed "corner handle unresponsive"); after the shift the center is 32px from the screen edge, clear of the gesture band (visual triangle still anchored in the corner) */
        .dbg-ai-resize { width: 44px; height: 44px; right: 10px; bottom: 10px; }
        .dbg-ai-resize::after { right: 5px; bottom: 5px; width: 11px; height: 11px; }
        .dbg-ai-resize-r { width: 24px; }
        .dbg-ai-resize-b { height: 24px; }
      }
    `;
    document.head.appendChild(css);
  }

    export function escapeHtml(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
