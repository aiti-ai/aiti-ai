// DOM 工厂 + 样式（自 dbg-launcher.js 拆分，源区块：宿主 DOM 工厂）
export function el(tag, attrs, children) {
  var node = document.createElement(tag);
  if (attrs) for (var k in attrs) node.setAttribute(k, attrs[k]);
  (children || []).forEach(function (c) {
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return node;
}

// lucide 线条 SVG 辅助（与系统内建/扩展图标同风格：stroke currentColor + strokeWidth 2）——launcher 内图标按钮统一用它
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
// launcher 常用 lucide 图标（inspect 十字线 = crosshair，与 aiti-devtools 顶栏点选图标一致）
export var LUCIDE = {
  crosshair: ['M22 12h-4', 'M6 12H2', 'M12 6V2', 'M12 22v-4', 'M12 12'],
};

  export function ensureStyles(accent) {
    if (document.getElementById('__dbg_launcher_css')) return;
    var css = document.createElement('style');
    css.id = '__dbg_launcher_css';
    css.textContent = `
      /* launcher 整体为最上层覆盖层（z-index 最高，任何 iframe/div 都盖不住）；pointer-events 穿透不挡页面交互 */
      /* 禁用本工具 UI 的浏览器触摸点击高亮（Android Chrome/HarmonyOS 点圆形按钮会叠淡蓝透明遮罩，看起来像方形背景/整窗遮罩）+ 长按菜单 */
      #__dbg_launcher, #__dbg_launcher * { -webkit-tap-highlight-color: transparent; -webkit-touch-callout: none; }
      #__dbg_launcher {
        all: initial; font: 13px/1.5 system-ui, sans-serif; color: #1f2937;
        position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;
      }
      #__dbg_launcher > * { pointer-events: auto; } /* 交互子元素恢复可点 */
      /* 信息/提示类覆盖层始终点击穿透：#__dbg_launcher > * 恢复可点会误伤它们（opacity:0 隐藏时仍拦截下方元素点击，block-tip/tooltip 实测挡点击）；
         hud 抓手 .dbg-hud-grip 子级显式 pointer-events:auto 覆盖继承的 none，仍可拖动 */
      #__dbg_launcher > .dbg-hud,
      #__dbg_launcher > .dbg-tooltip,
      #__dbg_launcher > .dbg-block-tip,
      #__dbg_launcher > .dbg-pick-toast { pointer-events: none; }
      #__dbg_launcher *, #__dbg_launcher *::before, #__dbg_launcher *::after { box-sizing: border-box; }
      .dbg-fab { position: fixed; right: 18px; z-index: 2147483646; display: flex; flex-direction: column; gap: 8px; touch-action: none; user-select: none; -webkit-user-select: none; }
      .dbg-fab.dbg-horz { flex-direction: row; } /* 贴顶/贴底：按钮左右排列 */
      .dbg-fab button {
        display: flex; align-items: center; justify-content: center; gap: 4px; width: 40px; height: 40px; padding: 0;
        border: 1px solid rgba(0,0,0,.12); border-radius: 50%; cursor: pointer;
        background: #fff; box-shadow: 0 2px 8px rgba(0,0,0,.18); font: inherit; white-space: nowrap; transition: all .2s;
      }
      .dbg-fab button::after { content: attr(data-label); font-size: 11px; opacity: 0; max-width: 0; overflow: hidden; transition: all .25s; }
      .dbg-fab button:hover { transform: translateY(-1px); }
      /* tooltip 展开文字：固定圆形按钮（40px）后 inline 推不动——left/right 都改绝对定位，不推图标/布局 */
      .dbg-fab button::after { content: attr(data-label); font-size: 11px; opacity: 0; max-width: 0; overflow: hidden; transition: all .25s; color: inherit; }
      .dbg-fab button[data-tip='left'], .dbg-fab button[data-tip='right'] { position: relative; }
      .dbg-fab button[data-tip='left']::after, .dbg-fab button[data-tip='right']::after {
        position: absolute; top: 50%; transform: translateY(-50%);
        max-width: 0; opacity: 0; overflow: hidden; white-space: nowrap; transition: all .25s;
        color: #374151; /* 深字——dbg-on 时按钮 color:#fff，若继承会白字白底看不见 */
      }
      .dbg-fab button[data-tip='left']::after { right: calc(100% + 2px); }
      .dbg-fab button[data-tip='right']::after { left: calc(100% + 2px); }
      .dbg-fab button[data-tip='left']:hover::after, .dbg-fab button[data-tip='right']:hover::after {
        max-width: 90px; opacity: 1; padding: 2px 6px; background: rgba(255,255,255,.95); border-radius: 8px;
      }
      /* 拖动中：禁用 hover 上浮 + 隐藏 tooltip（避免闪动） */
      .dbg-fab.dbg-dragging button { transform: none !important; }
      .dbg-fab.dbg-dragging button::after { opacity: 0 !important; max-width: 0 !important; }
      .dbg-fab button.dbg-on { background: ${accent}; color: #fff; border-color: ${accent}; }
      /* 页面错误提醒：AI 按钮红描边 + 角标（红点/数字）+ 脉冲闪烁（每个新错误触发；节奏慢、时长足，保证看得见） */
      .dbg-fab button.dbg-err { position: relative; border-color: #ef4444; box-shadow: 0 0 0 1px rgba(239,68,68,.35) inset; }
      .dbg-fab button.dbg-err-pulse { animation: dbg-fab-err-pulse 1.5s ease-out 4; } /* 慢速光晕扩散 4 轮 ≈ 6s */
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
      /* touch 点击：tooltip 立即显示，2s 后消失（touch 无 :hover out，展开会一直挂着） */
      .dbg-fab button.dbg-tip::after { opacity: 1; max-width: 90px; padding-left: 2px; }
      .dbg-fab button[data-tip='left'].dbg-tip::after, .dbg-fab button[data-tip='right'].dbg-tip::after { max-width: 90px; opacity: 1; padding: 2px 6px; background: rgba(255,255,255,.95); }
      .dbg-fab.dbg-nohover button:hover::after, .dbg-fab.dbg-nohover button.dbg-tip::after { opacity: 0 !important; max-width: 0 !important; }
      /* 触屏：禁用 fab/工具条/菜单按钮的 :hover 视觉（touch 点击后 :hover 残留，形成'hover整个窗口'错乱）——
         dbg-tip 类显式触发的 tooltip 不受影响（tap 仍显示 2s）；按钮的 :hover 背景/上浮全压掉 */
      #__dbg_launcher.dbg-touch-ui .dbg-fab button:hover,
      #__dbg_launcher.dbg-touch-ui .dbg-toolbar button:hover,
      #__dbg_launcher.dbg-touch-ui .dbg-extreme-menu button:hover,
      #__dbg_launcher.dbg-touch-ui .dbg-profile-item:hover,
      #__dbg_launcher.dbg-touch-ui .dbg-ai-bar button:hover,
      #__dbg_launcher.dbg-touch-ui .dbg-settings button:hover,
      #__dbg_launcher.dbg-touch-ui .dbg-speed button:hover { background: inherit !important; border-color: inherit !important; transform: none !important; }
      #__dbg_launcher.dbg-touch-ui .dbg-fab button:hover::after { opacity: 0 !important; max-width: 0 !important; }
      /* ---- Inspector 工具条（悬浮按钮排：选区微调） ---- */
      /* 工具条：双行（行1=选区信息稳定，行2=按钮稳定不跳）；色块区分（导航浅灰/✓绿/🖱紫/⏱橙/🔒靛/✕红） */
      .dbg-toolbar {
        display: none; flex-direction: column; padding: 4px 6px;
        background: rgba(255,255,255,.98); border: 1px solid #e2e8f0; border-radius: 10px;
        font-size: 12px; box-shadow: 0 4px 16px rgba(0,0,0,.14);
        touch-action: none; user-select: none; -webkit-user-select: none;
      }
      .dbg-toolbar.dbg-on { display: flex; }
      .dbg-toolbar.dbg-floating { position: fixed; z-index: 2147483647; } /* 最高层：确认弹窗（2147483645）打开时工具条仍可点 */
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
      /* selector 快速选择输入行 */
      .dbg-sel-input-row { display: none; margin-top: 3px; flex-direction: column; } /* 输入框独占一行，示例指示单独一行 */
      .dbg-sel-input-row input {
        width: 100%; box-sizing: border-box; border: 1px solid #c7d2fe; border-radius: 6px; padding: 4px 8px;
        font: inherit; font-size: 11px; background: #eef2ff;
      }
      .dbg-sel-hint { font-size: 10px; color: #94a3b8; line-height: 1.5; margin-top: 2px; }
      /* 小屏自适应（目标页未适配小屏，工具条自主放大优化）：
         compact = 视口<768 或触屏 → 按钮 38px/16px；touch = 触屏或 <480 → 按钮 44px/18px（触控标准） */
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
      /* 按钮点击 tooltip（几秒后消失） */
      .dbg-hud {
        position: fixed; z-index: 2147483647; /* 最高层：拖动/显示不被任何 UI（fab/工具条/面板）覆盖 */
        background: rgba(17,24,39,.94); color: #e5e7eb; border-radius: 10px; padding: 7px 12px;
        font-size: 11px; line-height: 1.65; min-width: 140px;
        transition: opacity .25s; pointer-events: none; opacity: 0; box-shadow: 0 6px 20px rgba(0,0,0,.4);
      }
      /* 小屏/触屏：HUD（按真实屏幕物理视口，layout 980 时媒体查询失效）；图标紧凑（小屏信息密度高不占屏） */
      #__dbg_launcher.dbg-phys-small .dbg-hud { font-size: 11px; padding: 6px 9px; min-width: 128px; line-height: 1.5; }
      #__dbg_launcher.dbg-phys-small .dbg-hud-path { max-width: 46vw; }
      /* 小屏工具条按钮换行（保证最右 ✓ 确认可见）：dbg-phys-small（设备<768）强制 wrap，
         不依赖 dbg-compact（受 isSmallScreen/isTouchCompact 影响，真机可能未触发） */
      #__dbg_launcher.dbg-phys-small .dbg-toolbar-btns { flex-wrap: wrap; }
      /* 小屏 dialog（确认预览弹窗）与 speed（调速/网络/错误）：字体图标放大（响应式，参照 AI 窗；14px 基准） */
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
      /* HUD 本体 pointer-events:none（不拦截页面交互——盖住弹出菜单时下方仍可 hover/点击）；
         右上角抓手 = 唯一拖动入口；.dbg-open-file 链接单独放行可点击 */
      .dbg-hud .dbg-hud-grip {
        position: absolute; top: 2px; right: 4px; z-index: 2;
        font-size: 10px; line-height: 1; color: #64748b; cursor: grab; user-select: none;
        padding: 1px 2px; pointer-events: auto;
        touch-action: none; -webkit-user-select: none; /* 触屏拖动：禁浏览器把手势当滚动（否则 pointercancel → 拖拽中断） */
      }
      .dbg-hud .dbg-hud-grip:hover { color: #c7d2fe; }
      /* pick HUD 按钮行：内容超高滚动时按钮 sticky 贴底始终可见（背景铺满 HUD 底边，不露穿帮） */
      .dbg-hud .dbg-hud-actions {
        position: sticky; bottom: 0; margin-top: 6px; margin-left: -12px; margin-right: -12px;
        padding: 3px 12px 7px; background: rgba(17,24,39,.94); border-radius: 0 0 10px 10px;
      }
      #__dbg_launcher.dbg-phys-small .dbg-hud .dbg-hud-actions {
        margin-left: -9px; margin-right: -9px; padding: 3px 9px 6px;
      }
      /* 工具条模拟 hover 按钮（真实事件派发）：开态高亮 */
      .dbg-toolbar .dbg-nav-hover { background: #ccfbf1; color: #0f766e; }
      .dbg-toolbar .dbg-nav-hover.dbg-on, .dbg-toolbar .dbg-nav-hover.dbg-on:hover { background: #0f766e; color: #fff; box-shadow: inset 0 0 0 1px rgba(204,251,241,.5); }
      /* 箭头指向选区（默认在选区下方：箭头朝上指向选区） */
      .dbg-hud::before {
        content: ''; position: absolute; top: -8px; left: 18px;
        width: 0; height: 0; border-left: 8px solid transparent; border-right: 8px solid transparent;
        border-bottom: 8px solid rgba(17,24,39,.94);
      }
      /* 翻到选区上方：箭头在底部指向选区 */
      .dbg-hud.dbg-hud-up::before {
        top: auto; bottom: -8px;
        border-bottom: 0; border-top: 8px solid rgba(17,24,39,.94);
      }
      .dbg-hud b { color: #fff; }
      .dbg-hud i { color: #93c5fd; font-style: normal; }
      .dbg-hud .dbg-hud-path { color: #94a3b8; }
      .dbg-tooltip {
        position: fixed; z-index: 2147483648; background: rgba(17,24,39,.94); color: #e5e7eb; /* hover popup 同款：dark/圆角/多行 */
        font-size: 11px; line-height: 1.65; padding: 7px 12px; border-radius: 10px; max-width: min(340px, 90vw);
        transition: opacity .3s; pointer-events: none; opacity: 0; box-shadow: 0 6px 20px rgba(0,0,0,.4);
      }
      @media (max-width: 768px), (pointer: coarse) { .dbg-tooltip { font-size: 14px; padding: 9px 14px; } }
      /* 事件拦截提示条（底部/顶部 toast，闪避鼠标）：纯信息展示 pointer-events 常关——不吞下方元素点击；
         垂直位置由 showBlockedTip 按拦截点所在半屏写 inline top/bottom（下半屏拦截 → 上半展示），此处仅创建时兑底 */
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
        position: fixed; z-index: 2147483647; min-width: 220px; background: #fff; /* 最高层（与工具条同级，后创建在上）：下拉不被工具条盖 */
        border: 1px solid rgba(0,0,0,.15); border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.2);
        padding: 4px; font-size: 12px;
      }
      .dbg-profile-item { display: flex; justify-content: space-between; gap: 8px; align-items: center; padding: 6px 10px; border-radius: 7px; cursor: pointer; }
      .dbg-profile-item:hover { background: #eef2ff; }
      .dbg-profile-item.dbg-on { background: #e0e7ff; font-weight: 600; }
      /* 放行下拉：常驻动作项「⚙️ 自定义…」+ 分隔线 */
      .dbg-profile-divider { height: 1px; background: #e2e8f0; margin: 3px 4px; }
      .dbg-profile-item.dbg-profile-action { color: #4338ca; }
      .dbg-profile-item.dbg-profile-action:hover { background: #eef2ff; }
      .dbg-profile-label { font-weight: 600; }
      .dbg-profile-desc { font-size: 10px; color: #6b7280; }
      /* 小屏：放行方案下拉字体跟随（原 12px/10px 固定） */
      #__dbg_launcher.dbg-phys-small .dbg-profile-menu { font-size: 13px; min-width: 250px; }
      #__dbg_launcher.dbg-phys-small .dbg-profile-item { padding: 8px 11px; }
      #__dbg_launcher.dbg-phys-small .dbg-profile-desc { font-size: 11px; }
      /* ❓ 帮助窗（help 子系统）：底部居中浮层，可滚动，头部可拖；z-index 2147483648 盖工具条 */
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
      #__dbg_launcher.dbg-phys-small .dbg-help-nav-row button { padding: 10px 14px; } /* 触控 44px 目标 */
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
      /* ---- AI 悬浮窗（可拖拽/贴边/调宽高） ---- */
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
        touch-action: none; /* 触屏拖动：禁止浏览器把手势当滚动（否则 pointercancel → 拖拽中断，pad 实测卡住；pointerdown preventDefault 管不了触屏滚动） */
        -webkit-touch-callout: none; /* iOS 长按不弹系统菜单 */
        position: relative; z-index: 3; /* 盖住 resize 手柄（z2）：右缘拖拽条(.dbg-ai-resize-r 14px)会盖到关闭按钮 → 点关闭变拖动（用户实测） */
      }
      .dbg-ai-bar .dbg-ai-title { font-weight: 600; margin-right: auto; color: #374151; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 38vw; flex-shrink: 1; display: flex; align-items: center; gap: 5px; }
      .dbg-ai-bar .dbg-ai-favicon { width: 14px; height: 14px; border-radius: 3px; flex-shrink: 0; }
      .dbg-ai-bar button {
        border: 1px solid #d1d5db; background: #fff;
        padding: 0; width: 26px; height: 26px; border-radius: 50%;
        cursor: pointer; font: inherit; font-size: 11px; color: #4b5563;
      } /* 图标按钮（最大化/新窗口/设置/关闭）正圆 */
      .dbg-ai-bar button:hover { background: #eef2ff; border-color: #c7d2fe; }
      .dbg-ai-bar .dbg-ai-close { color: #dc2626; }
      /* 小屏：AI 窗标题栏精简——默认全屏贴边（最大化），仅 最大化/新窗口/设置/关闭 四钮 */
      #__dbg_launcher.dbg-phys-small .dbg-ai-bar { height: 34px; padding: 0 6px; font-size: 12px; gap: 4px; }
      #__dbg_launcher.dbg-phys-small .dbg-ai-bar .dbg-ai-title { font-size: 12px; }
      #__dbg_launcher.dbg-phys-small .dbg-ai-bar button { min-width: 26px; min-height: 26px; font-size: 12px; padding: 1px 5px; }
      /* 分组间距：右侧固定组（⛶⧉⚙✕）前留白（不再挤成一团，触屏不易误触） */
      #__dbg_launcher.dbg-phys-small .dbg-ai-bar .dbg-ai-max { margin-left: 10px; }
      #__dbg_launcher.dbg-phys-small .dbg-ai-bar .dbg-ai-pop { margin-left: 10px; }
      #__dbg_launcher.dbg-phys-small .dbg-ai-resize { display: none; } /* 小屏全宽贴边，尺寸自适应，无角柄 */
      /* 小屏：resize 边缘拖条（右/下/左）隐藏——小屏手势已被 filter:!small 禁用（拖不动），
         却仍覆盖 iframe 对应边缘（底部 24px 命中区挡住内容点击、点击无效）→ 纯遮挡，隐藏释放边缘 */
      #__dbg_launcher.dbg-phys-small .dbg-ai-resize-r,
      #__dbg_launcher.dbg-phys-small .dbg-ai-resize-b,
      #__dbg_launcher.dbg-phys-small .dbg-ai-resize-l { display: none; }
      #__dbg_launcher.dbg-phys-small .dbg-ai-win iframe { height: calc(100% - 34px) !important; }
      .dbg-ai-resize {
        position: absolute; right: 0; bottom: 0; width: 20px; height: 20px;
        cursor: nwse-resize; z-index: 2;
        touch-action: none; -webkit-user-select: none; /* 触屏 resize 手柄同拖动条：禁浏览器滚动手势 */
      }
      /* 左缘拖条（镜像右缘）：单轴调宽（左缘跟手、右缘锚定）——小屏也保留（用户实测左下角拖不了，只有右/下有缘条） */
      .dbg-ai-resize-l {
        position: absolute; left: 0; top: 0; width: 14px; height: 100%;
        cursor: ew-resize; z-index: 2; touch-action: none; -webkit-user-select: none;
      }
      /* 边缘拖条（右/下）：单轴调宽/调高——触屏只有右下角手柄必须斜拖且贴屏底时落在系统手势区，
         真实手指很难用；边缘条长且好点。默认透明，hover/触屏加宽命中区（44px）可见提示 */
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
      /* 只在悬停指示条本身时点亮（原 .dbg-ai-win:hover = 鼠标在窗口任意位置都亮 → 看着"一直显示"，触屏 sticky-hover 更明显）；
         真正要拖动该位置（指针到边缘条）才提示 */
      .dbg-ai-resize-r:hover::after, .dbg-ai-resize-b:hover::after, .dbg-ai-resize-l:hover::after { background: rgba(99,102,241,.35); }
      /* 拖动中才亮（含触屏——替代旧"触屏常显"方案：常显是视觉噪音，用的时候给反馈即可）：
         dbg-resizing class 由手势层挂/摘（拖动开始加、结束去） */
      .dbg-ai-win.dbg-resizing .dbg-ai-resize-r::after, .dbg-ai-win.dbg-resizing .dbg-ai-resize-b::after, .dbg-ai-win.dbg-resizing .dbg-ai-resize-l::after, .dbg-ai-win.dbg-resizing .dbg-ai-resize::after { background: rgba(99,102,241,.6); }
      /* 右下角 L 抓手：默认隐藏，hover 才亮（与边缘条一致——常显是视觉噪音） */
      .dbg-ai-resize::after {
        content: ''; position: absolute; right: 3px; bottom: 3px;
        width: 8px; height: 8px; border-right: 2px solid transparent; border-bottom: 2px solid transparent;
        border-radius: 2px; transition: border-color .15s;
      }
      .dbg-ai-resize:hover::after { border-color: rgba(99,102,241,.6); }
      /* ---- ⧉ 新窗口布局下拉（Chrome Inspector 式：独立弹窗 / 左右分屏 / 上下分屏） ---- */
      .dbg-ai-pop-menu {
        position: fixed; z-index: 2147483647; min-width: 200px;
        background: #fff; border: 1px solid rgba(0,0,0,.15); border-radius: 10px;
        box-shadow: 0 8px 32px rgba(0,0,0,.25); padding: 4px; font-size: 12px;
      }
      .dbg-ai-pop-menu-item { display: flex; flex-direction: column; gap: 1px; padding: 6px 10px; border-radius: 7px; cursor: pointer; color: #374151; }
      .dbg-ai-pop-menu-item:hover { background: #eef2ff; }
      .dbg-ai-pop-menu-item.dbg-on { background: #4f46e5; color: #fff; }
      .dbg-ai-pop-menu-desc { font-size: 10px; opacity: .72; }
      /* ---- 调速/拦截面板 ---- */
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
      /* ---- 危险命令确认卡 ---- */
      /* AI 窗设置弹窗（⚙）：小屏高度%+贴边 / 大屏宽高+位置；z 高于 AI 窗（2147483642）——不被自身遮挡；浅色主题与 launcher 弹窗一致 */
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
      /* 点选/问答/通知面板（aiti-user-*）：右下角浮层——不覆盖全屏、可拖拽可最小化；
       * 宽度运行时由 placePhysPanel 内联接管（问答面板 520、小屏自动 w-24），CSS 值仅挂载前瞬间生效 */
      .dbg-pick-dialog {
        position: fixed; right: 12px; bottom: 12px; z-index: 2147483646; width: 520px; max-width: 92vw;
        background: linear-gradient(180deg, rgba(30,41,59,.98), rgba(17,24,39,.98)); color: #e5e7eb; border-radius: 14px;
        border: 1px solid rgba(148,163,184,.22);
        box-shadow: 0 12px 40px rgba(0,0,0,.5); font-size: 14px; overflow: hidden;
      }
      /* 短暂提示（toast）：交互到达时提示用户，几秒自动消失——不阻塞、不弹确认窗 */
      .dbg-pick-toast {
        position: fixed; z-index: 2147483648; background: rgba(17,24,39,.95); color: #e5e7eb;
        border-radius: 10px; padding: 8px 12px; font-size: 12px; line-height: 1.6;
        box-shadow: 0 8px 30px rgba(0,0,0,.4); text-align: center; pointer-events: none;
        transition: opacity .4s; word-break: break-all;
      }
      .dbg-pick-head { padding: 10px 14px; font-weight: 600; font-size: 14px; display: flex; align-items: center; gap: 8px; cursor: grab; touch-action: none; background: rgba(255,255,255,.045); border-bottom: 1px solid rgba(148,163,184,.16); } /* cursor grab + touch-action:none：头部可拖拽（makePointerDrag，AI 窗同款） */
      .dbg-pick-dialog.dbg-dragging { cursor: grabbing; opacity: .92; box-shadow: 0 14px 44px rgba(0,0,0,.55); }
      .dbg-pick-head .dbg-pick-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dbg-pick-head button { border: 1px solid transparent; background: rgba(255,255,255,.12); color: #e5e7eb; border-radius: 6px; padding: 3px 10px; cursor: pointer; font: inherit; font-size: 13px; }
      .dbg-pick-head button:hover { background: rgba(255,255,255,.2); }
      .dbg-pick-body { padding: 14px; font-size: 14px; color: #d3d9e0; line-height: 1.6; }
      .dbg-pick-body input::placeholder { color: #64748b; }
      .dbg-pick-body .dbg-pick-sel { margin: 6px 0; font-size: 14px; color: #93c5fd; word-break: break-all; }
      .dbg-pick-body button { border: 0; border-radius: 7px; padding: 9px 14px; cursor: pointer; font: inherit; font-size: 15px; }
      /* ---- 问答面板（aiti-user-*）视觉契约（2026-09 优化：可读性/配色/宽度/编号/小屏） ----
       * 问题区（.dbg-ask-prompt）：大字号高对比 + 左侧强调条——AI 的问题是面板最重要信息
       * 选项区：垂直全宽列表（长文案不挤压换行）+ 数字徽标（1/2/3…，与键盘快捷键 1-9 对应）
       * 语义配色：主操作（是/确认/我在）绿色渐变；否定/取消红字浅红 hover；「都不适合」虚线灰 */
      .dbg-ask-prompt { white-space: pre-wrap; font-size: 15px; font-weight: 600; color: #f8fafc; line-height: 1.7; word-break: break-word; background: rgba(96,165,250,.08); border-left: 3px solid #60a5fa; border-radius: 6px; padding: 10px 12px; margin-bottom: 10px; }
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
      /* 「现在无法处理」拒绝区按钮（原 inline 样式收编进 CSS：跨面板统一） */
      .dbg-ask-reject { font-size: 13px; padding: 8px 12px; background: rgba(255,255,255,.06); border: 1px solid rgba(148,163,184,.3); color: #e5e7eb; border-radius: 8px; cursor: pointer; }
      .dbg-ask-reject:hover { background: rgba(255,255,255,.13); }
      .dbg-pick-ok { background: #4f46e5; color: #fff; }
      .dbg-pick-cancel { background: rgba(255,255,255,.12); color: #e5e7eb; margin-right: 6px; }
      /* 问答面板发送按钮（手写输入/多选发送）：亮绿高亮——原无底色透明、深色面板上几乎看不见（用户实测） */
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
      .dbg-dialog-head { padding: 12px 14px; font-weight: 600; border-bottom: 1px solid #e5e7eb; display: flex; justify-content: space-between; align-items: center; gap: 8px; cursor: grab; touch-action: none; } /* cursor grab + touch-action:none：头部可拖拽（makeCardDrag） */
      .dbg-dialog-card.dbg-dragging { cursor: grabbing; opacity: .95; box-shadow: 0 24px 70px rgba(0,0,0,.4); }
      .dbg-dialog-head code { font-size: 11px; color: ${accent}; background: ${accent}18; padding: 2px 6px; border-radius: 6px; }
      .dbg-dialog-head .dbg-loc { font-size: 11px; color: #6b7280; font-weight: 400; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dbg-dialog-body { padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
      /* ---- 预览界面 ---- */
      .dbg-preview { border: 1px solid #e5e7eb; border-radius: 8px; background: #f9fafb; padding: 8px 10px; font-size: 11px; }
      .dbg-preview .dbg-pv-row { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 4px; }
      .dbg-preview .dbg-pv-row:last-child { margin-bottom: 0; }
      .dbg-preview b { color: #374151; }
      .dbg-preview .dbg-pv-kv { color: #6b7280; background: #fff; border: 1px solid #e5e7eb; border-radius: 4px; padding: 1px 5px; }
      .dbg-preview .dbg-pv-file { color: #059669; word-break: break-all; }
      /* 行复制按钮：hover 显示（📋）——iframe 内 Clipboard 失败时经 dbg_copy 协议转发宿主 */
      .dbg-preview .dbg-pv-copy { opacity: 0; transition: opacity .15s; margin-left: 4px; padding: 0 6px; font-size: 10px; cursor: pointer; border: 1px solid #d1d5db; border-radius: 4px; background: #fff; color: #374151; vertical-align: middle; }
      .dbg-preview .dbg-pv-row:hover .dbg-pv-copy { opacity: 1; }
      /* 文件行操作按钮（📂 后台 / 🖥 前端）：同样 hover 才显示，避免默认铺满干扰阅读 */
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
      /* ---- 调试信息窗口（替代临时 toast）+ 设置弹窗 ---- */
      .dbg-overlay { position: fixed; inset: 0; z-index: 2147483644; background: rgba(17,24,39,0); display: none; } /* 遮罩改透明：不盖页面（用户误认'浅蓝全窗遮罩'）——点击卡片外空白即关闭 */
      .dbg-overlay.dbg-open { display: block; }
      .dbg-overlay-card { position: fixed; top: 0; left: 0; background: #fff; border-radius: 14px; box-shadow: 0 20px 60px rgba(0,0,0,.4); max-width: 92vw; display: flex; flex-direction: column; }
      .dbg-overlay-card .dbg-dialog-body { flex: 1 1 auto; overflow: auto; min-height: 0; } /* 头/尾固定，中间滚动——底部按钮始终可见 */
      .dbg-debug-info { font: 11px/1.6 ui-monospace,monospace; white-space: pre-wrap; word-break: break-all; background: #0f172a; color: #e5e7eb; border-radius: 8px; padding: 10px 12px; }
      .dbg-debug-help { font-size: 12px; color: #4b5563; line-height: 1.85; }
      .dbg-debug-help b { color: #111827; display: block; margin-bottom: 4px; }
      .dbg-debug-help code { background: #f3f4f6; padding: 1px 5px; border-radius: 4px; font: 11px ui-monospace,monospace; color: #374151; }
      .dbg-settings { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.2); display: flex; flex-direction: column; gap: 8px; min-width: 200px; }
      .dbg-settings label { display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; }
      .dbg-settings button { border: 1px solid #d1d5db; background: #fff; border-radius: 6px; padding: 6px 10px; cursor: pointer; font: inherit; font-size: 12px; }
      .dbg-settings button:hover { background: #f9fafb; }
      /* hover 调试面板（点 inspect/HUD 后 hover 是否被抑制；可复制贴给 AI） */

      /* ===== 小屏自适应（主页面是否适配小屏不管，我们自己的 UI 适配） ===== */
      /* 小屏判断按设备物理尺寸（screen.width）加 class——不依赖 layout 视口（移动端 layout=980 会误判）；不用视觉视口（用户缩放会变→小屏误判大屏） */
      .dbg-fab.dbg-smal button { width: 46px; height: 46px; font-size: 12px; }
      .dbg-fab.dbg-tiny button { width: 48px; height: 48px; font-size: 13px; }
      /* 小屏：AI/inspect 按钮被选中（dbg-on）不显示实心方形背景——胶囊/圆形上加 accent 实底看起来像方块。
         保持透明底 + accent 描边 + 图标即可区分，无方块感 */
      #__dbg_launcher.dbg-phys-small .dbg-fab button.dbg-on { background: transparent !important; background-color: transparent !important; box-shadow: inset 0 0 0 2px ${accent}; }
      /* 触屏或窄视口 <768：AI 窗尺寸已由 JS placePhysBox（capVisW/capVisH）精确控制，
         这里只留 bar/panel 视觉尺寸——移除 .dbg-ai-win 的 !important 宽高（与 placePhysBox 冲突：
         pointer:coarse 在无 meta 触屏页 100vw=980 → width 960 超屏；响应式页 78vh/100vw 高度也不对） */
      /* 窄视口 <768 才放大按钮尺寸——用户实测宽触屏（777px）吃 pointer:coarse 档后标题栏图标偏大（首载正常、后来变大）
         故只按宽度触发；resize 手柄仍单独走 @media (pointer: coarse)（见下） */
      @media (max-width: 767px) {
        .dbg-ai-bar { height: 32px; }
        .dbg-ai-bar button { min-width: 28px; min-height: 28px; font-size: 14px; }
        .dbg-ai-bar .dbg-ai-title { font-size: 12px; }
        .dbg-speed { right: 10px; width: calc(100vw - 20px); max-height: calc(100vh - 90px); }
        .dbg-panel { right: 10px; width: calc(100vw - 20px); }
      }
      /* 触屏或 <480：最大触控尺寸 */
      @media (max-width: 479px) {
        /* 仅窄屏手机：32px 触控按钮；宽触屏（平板/大屏触控）用上一档 28px——用户实测 38/32px 过大（标题栏图标嫌大） */
        .dbg-ai-bar button { min-width: 32px; min-height: 32px; font-size: 15px; }
      }
      @media (pointer: coarse) {
        /* resize 手柄/边缘拖条：命中区放大到触控标准（视觉标不变，::after 锚在角落）——
           否则手指按不到小角落（按到窗外/iframe 上），触屏完全用不了；
           视觉提示不再常显（旧方案）——拖动中才亮（.dbg-resizing，见上），平时隐形 */
        /* 角柄热区从角落内移 10px：窗口贴屏缘（全宽/贴边）时角柄压在屏幕角落——Android 系统手势区
           （back swipe 竖边 + home 横条），真实手指一碰就被系统抢走（pointercancel 提前结束，
           实测"角柄没反应"）；内移后中心离屏缘 32px 避开手势带（视觉三角仍锚角落） */
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
