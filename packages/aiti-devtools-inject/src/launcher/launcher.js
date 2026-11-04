/**
 * launcher.js —— 页面内 AI 调试助手 · 宿主入口（自 dbg-launcher.js 拆分，阶段 A+B：闭包 + 纯提取）
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

// AI 窗特征检测（防嵌套）：popup 同名窗口 / _dbg URL 参数（aiwin 拼 AI 窗地址的专有参数）/
// 共享库特征对象 __AITI_AI_WIN__（aiti-client 顶层按「AI 窗身份」判定后置——带 _dbg/popup 名才置，
// 普通 pi-web 页不置不误杀；覆盖参数被清洗/重复注入兑底）。
// 注意不用 AitiHostProtocol：它在所有 pi-web 页都加载，会把普通页的 launcher 误杀。
function aiWindowMarkers() {
  try {
    return window.name === 'aiti-ai-popup'
      || /[?&]_dbg=/.test(location.search)
      || /[?&]_dbg=/.test(location.hash)
      || !!window.__AITI_AI_WIN__;
  } catch (e) { return false; }
}

export function createDbgLauncher(url, opts) {
  // 防嵌套：本页若是 aiti AI 窗 → 不启动 launcher。
  // 否则 AI 窗里再预创建 AI 窗、逐层嵌套（dev ai 里套 prod ai…），同站 iframe 共享 renderer 主线程，
  // 几层下来主线程被拖死——被调试页直接卡死（多刷新几次必现）。
  // 特征（任一命中即认定）：
  //   ① window.name = aiti-ai-popup（popup 模式，openAiPopup 同名窗口）
  //   ② URL 带 _dbg=（aiwin 拼 AI 窗 URL 的专有参数，业务页不会碰巧命中）
  //   ③ 共享库特征对象：window.__AITI_AI_WIN__（aiti-client 顶层按「AI 窗身份」判定后置——
  //       带 _dbg/popup 名才置，普通 pi-web 页不置不误杀；覆盖参数被清洗/重复注入兜底）
  try {
    if (aiWindowMarkers()) {
      if (window.console && console.info) console.info('[aiti] 检测到 AI 窗特征（popup 名/_dbg 参数/共享库对象）——不加载 launcher（防嵌套）');
      return null;
    }
  } catch (e) {}
  // ---- 共享 ctx（全部闭包变量/函数上 ctx；Phase A 注册 = 原函数声明提升） ----
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
  initHelp(ctx); // ❓ 帮助窗（hostKey 最前一档依赖 helpDialogOpen/closeHelpDialog，先于 routing/inspector 事件消费即可）
  initInject(ctx);
  initAiwin(ctx);
  initRouting(ctx);
  initInspector(ctx);
  initDialog(ctx);
  initPicks(ctx);
  initDebug(ctx);
  // ---- Phase B：原文顺序执行初始化语句（var→ctx 赋值 / DOM 创建 / 事件绑定 / 顶层调用） ----
    // 幂等：一次 inject 只有一个 launcher（一个 Inspector 按钮）；重复调用返回已有实例
  ctx.existingLauncher = window.document && document.getElementById('__dbg_launcher');
    if (ctx.existingLauncher && ctx.existingLauncher.__dbgLauncher) return ctx.existingLauncher.__dbgLauncher;
  ctx.cfg = Object.assign({}, DEFAULTS, opts || {});
  // self 宿主页（opts.selfHostPage，由 standalone 注入入口按「launcher 与页面同源 + pi-web 应用页」判定）：
  // 不预建/不恢复 AI 窗、隐藏 💬 按钮、退出点选不弹回 AI 窗——页面自身即 AI 窗，顶部 InspectButton
  // + 页面内点选闭环已足够。跨实例 launcher（同源判定不过）不进此模式，保持原行为。
  ctx.selfHostPage = !!(opts && opts.selfHostPage);
  ctx.iframeObservers = []; // 保存所有 observer 供 destroy 断开（须在 watchIframes 调用前赋值）
    // 阶段 3：url 可选（目标 = 宿主 + 宿主真实 iframe；url 仅作历史参数保留）

    ensureStyles(ctx.cfg.accent);

    // ---- launcher 状态持久化：刷新（HMR 整刷/手动 F5）后自动恢复（AI 窗口/位置/方案/视口等） ----

  ctx.dbgState = ctx.loadDbgState();
  ctx.aiOpen = !!ctx.dbgState.aiOpen; // 刷新前 AI 窗口开着 → 刷新后自动重开（记忆恢复）



  ctx.root = el('div', { id: '__dbg_launcher' });
    // 提前挂载：head 同步 script 时 body 可能未就绪——body 出现立即挂（不依赖页面 load，AI 窗口尽早出现）

    ctx.mountRoot(); // 只负责提前挂载 + 注入；AI 窗口恢复在末尾（aiBtn 就绪后）
    // 注：launcher 不负责连桥——所有连接由 AI 窗口负责（AI 窗连桥 role=ai + 操作经 host-protocol 转发宿主执行）；
    // 页面连桥仅独立桥场景手动触发（面板 🔌 按钮 → dbg_mcp_connect），launcher 启动不自动连

    // ---------------- 两个浮动按钮（最开始只注入它们） ----------------
  ctx.fab = el('div', { class: 'dbg-fab' });
  ctx.aiBtn = el('button', { 'data-label': 'AI 消息' }, ['💬']);
  ctx.inspBtn = el('button', { 'data-label': 'Inspector' }, [elSvg(LUCIDE.crosshair, 15)]);
    ctx.fab.appendChild(ctx.aiBtn);
    ctx.fab.appendChild(ctx.inspBtn);
    // self 宿主页：💬（无 AI 窗可开）和 🎯（顶部工具条已有 InspectButton）都不需要——
    // 整个 FAB 隐藏，只用顶部一个工具条按钮（用户要求）。跨实例 launcher 不进此模式，FAB 照常。
    if (ctx.selfHostPage) ctx.fab.style.display = 'none';
    // ---- fab 拖放沿边滑行（小屏自适应核心）：按住空白区拖动，松手吸附最近边；贴边后可沿边继续拖动滑行 ----
    // 贴边规则：右边=上下滑行 / 底部=左右滑行 / 左边=上下滑行 / 顶部=左右滑行；位置 localStorage 持久化（刷新恢复）
    // ---- 视觉边界 + 缩放系数（视觉 px 统一坐标）： ----
    //   w/h = 屏宽/高（移动无 meta：layout=980 明显宽于屏时用 screen；桌面：窗口=innerWidth）——恒不随 pinch 变
    //   scale = "屏/布局" 归一化系数（布局坐标 ×scale = 视觉 px；counter-zoom ÷scale 换算布局）
    //   关键坑（iOS Safari/微信老内核）：visualViewport.scale 可能缺失或语义相反（报"布局/屏"而非"屏/布局"），
    //   且无 meta 页面 pinch 时 innerWidth×scale ≠ 屏宽——按钮贴边会飞屏外/屏内错位。
    //   检测：vv.width×scale 命中屏宽 = 正向；vv.width÷scale 命中屏宽 = 反向（取倒数）

    // ---- clientX 坐标系检测：触摸/鼠标坐标在真实设备是视觉屏坐标（ppk/Chromium），
    //      但 CDP 模拟/部分 WebView 报布局坐标——用 rect(布局) 与 rect×scale(视觉) 的接近度判断，拖动按语义换算 1:1 跟手 ----

    // ---- position:fixed 语义：Chrome/Android/桌面相对 layout viewport（需 /scale + vv.offset 补偿）；
    //      iOS（Safari/Chrome/微信等均为 WebKit 内核）fixed 相对 visual viewport（left/width 直接视觉值）——
    //      纯 layout 在 iOS：fab left=845 布局被当视觉 → 屏外（Inspect 不可见）、AI 窗 width=927 超屏（用户实测小屏无缩放时看不见）----

    // ---- 统一物理固定函数：把元素固定在屏幕视觉 (visX, visY) 处（任意缩放/滚动/pan 都不动）----
    //   原理：position:fixed 相对 layout viewport（缩放会动）→ counter-zoom transform 抵消缩放；
    //   pinch 后 pan 时视觉视口在布局中偏移（vv.offsetLeft/Top）→ 浏览器渲染 fixed：屏上 = (布局left − offsetLeft)×scale，
    //   故布局 left = visX/scale **+** offsetLeft（加！MDN 官方方案同向：fixed left = vv.offsetLeft）——屏上恒 = visX
    //   注意方向：减号会把按钮随 pan 越推越远直到屏外（用户实测"pan 到左边才能看到按钮"）

    // 视觉尺寸 ↔ CSS 尺寸（counter-zoom 非等比——唯一换算源，别再手算 ×scale/scaleY！）
    //   transform scale(1/scale) 恒等比（origin top-left）；页面横向缩 scale、纵向 scaleY：
    //     visual_w = css_w                  （横向：1/scale × scale = 1 精确抵消）
    //     visual_h = css_h × scaleY/scale   （纵向：1/scale × scaleY ≠ 1）
    //   故 css_w = visW，css_h = visH × scale/scaleY（_fixedVisual 无 transform，css=visual 直接）

    // 视觉宽度上限（与调试卡同一源）：取 vp.w 与 visualViewport.width（恒 CSS、最可靠）的较小值减边距——防 vp.w 偏大

    // 视觉高度上限（同 capVisW）：vp.h（屏高，恒）


    // ---- 设备物理尺寸（CSS px，不随页面缩放/窗口 resize 变化）：screen.width/height ----
    //   页面缩放（pinch/ctrl+/-）只改 visualViewport.scale，screen 不变——大小屏判定稳定（适配"物理尺寸"而非"缩放后的尺寸"）
    //   注：screen.width = 设备物理像素 / devicePixelRatio（如 iPhone 375CSS×dpr3 → 375；桌面 1280CSS×dpr1 → 1280）

    // ---- 大小屏识别（多信号融合，ppk 视口研究结论）----
    //  ① screen.width（CSS px）：现代移动浏览器 = 理想视口（设备 DIP，如 375）；桌面 Chrome/Safari = 物理屏
    //  ② 老浏览器坑：Android 老 WebView screen 返回物理像素（1080+）→ 误判大屏
    //     修正：getPhysScreen 多信号判定（UA-CH mobile + outerWidth/availWidth 交叉，平板不误伤）
    //  ③ 桌面 Firefox/Edge 坑：screen.width 随 page-zoom 变（ppk）——低频，接受（Chrome/Safari 稳定）



    // ---- fab 物理锚点：视觉位置固定（页面缩放时 counter-zoom，按钮悬停页边不跟着缩放） ----
  ctx.fabEdge = null; // 'left'|'right'|'top'|'bottom'
  ctx.navHoldT = 0; // 导航保持时间戳（doNav 设置，updateHud/floatToolbar 读取）
    // ---- 导航（工具条按钮 / 键盘 hostKey 共用）：选区来源路由（宿主 selfEngaged → selfClient.step；target → postToTarget）----
    // 注意：必须顶层定义（键盘 hostKey 顶层调用；原定义在 buildToolbar 内 → ReferenceError: doNav is not defined → 键盘全失效）

  ctx.fabPhys = null; // {x, y} 物理像素位置（视觉目标，缩放不变）
  ctx.suppressClick = false; // fab 拖动结束标志：拦截随后的 click（避免误触按钮 toggle）
    // touch 点击 tooltip：立即显示展开文字，2s 后自动消失（touch 无 :hover out，:hover 展开会一直挂着）
    ctx.fab.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'touch') {
        ctx.fab.classList.remove('dbg-nohover'); // 新触摸：恢复 tooltip 能力
        ctx.fab.querySelectorAll('button').forEach(function (x) { x.classList.remove('dbg-tip'); });
        var b = e.target && e.target.closest ? e.target.closest('button') : null;
        if (b) b.classList.add('dbg-tip');
        if (ctx.fab.__tipT) clearTimeout(ctx.fab.__tipT);
        ctx.fab.__tipT = setTimeout(function () {
          ctx.fab.querySelectorAll('button').forEach(function (x) { x.classList.remove('dbg-tip'); });
          ctx.fab.classList.add('dbg-nohover'); // 压掉 :hover 残留展开（tap 后 :hover 保持到下次 tap）
        }, 2000);
      }
    });
    // FAB 拖动（公共手势工具 makePointerDrag）：按钮区域也可开始拖动——移动超阈值（6px）即变拖动；
    // 未移动 = 正常点击（不 preventDefault / 不立即捕获，保 click 落按钮；捕获策略 capture:'late' 由公共层处理）
    makePointerDrag({
      handle: ctx.fab, threshold: 6, capture: 'late',
      onStart: function (e) {
        // 偏移用视觉目标 fabPhys（不是布局 rect——rect 是布局坐标，clientX 是视觉坐标，混合会让拖动目标恒=初始布局位置拖不走）
        var vp0 = getPhysViewport();
        var coordLayout = detectCoordSemantics(ctx.fab, e.clientX); // clientX 是布局还是视觉（CDP/WebView 可能布局）
        // ox/oy 恒为视觉偏移：clientX 按语义 ×scale 转视觉后与 fabPhys（视觉）同源相减
        var xv = e.clientX * (coordLayout ? vp0.scale : 1);
        var yv = e.clientY * (coordLayout ? vp0.scaleY : 1);
        return { ox: xv - (ctx.fabPhys ? ctx.fabPhys.x : 0), oy: yv - (ctx.fabPhys ? ctx.fabPhys.y : 0), coordLayout: coordLayout };
      },
      onMove: function (ev, st) {
        ctx.fab.classList.add('dbg-dragging'); // 拖动中：禁 hover 上浮/tooltip
        // clientX/Y 按检测语义换算视觉：布局源 ×scale（横向）/×scaleY（纵向）→ 视觉目标；视觉源直接用
        var vp = getPhysViewport();
        var sx = st.coordLayout ? vp.scale : 1;
        var sy = st.coordLayout ? vp.scaleY : 1;
        ctx.fabPhys = { x: ev.clientX * sx - st.ox, y: ev.clientY * sy - st.oy };
        ctx.applyFabView();
      },
      onEnd: function (ev, st, moved) {
        ctx.fab.classList.remove('dbg-dragging');
        if (moved) { ctx.suppressClick = true; setTimeout(function () { ctx.suppressClick = false; }, 80); } // 拦截随后的 click（避免误触按钮 toggle）
        if (!moved) return;
        var vp = getPhysViewport();
        var r = ctx.fab.getBoundingClientRect();
        var vw = vp.w, vh = vp.h; // 物理视口
        // rect 语义：Chrome layout rect=布局坐标（×scale→视觉）；iOS visual rect=视觉坐标（直接）
        var _rm = _fixedVisual ? 1 : vp.scale;
        var cx = (r.left + r.width / 2) * _rm, cy = (r.top + r.height / 2) * (_fixedVisual ? 1 : vp.scaleY);
        var dl = cx, dr = vw - cx, dt = cy, db = vh - cy;
        var minH = Math.min(dl, dr), minV = Math.min(dt, db);
        // 吸附最近边（拖过屏幕一半即对边）；沿边位置（另一轴）由 refreshFabAnchor clamp 保留
        ctx.fabEdge = (minV <= minH) ? (dt <= db ? 'top' : 'bottom') : (dl <= dr ? 'left' : 'right');
        ctx.fabPhys = { x: cx, y: cy };
        ctx.applyFabOrient();
        ctx.refreshFabAnchor(); // 按新 edge/方向重算贴边锚点（横竖切换后 offsetWidth/Height 已变）
        ctx.persistFabPos();
      },
    });
    // capture 阶段拦截：拖动（移动超阈值）后吞掉按钮 click，避免误触发 toggle
    ctx.fab.addEventListener('click', function (e) {
      if (ctx.suppressClick) { e.stopPropagation(); e.preventDefault(); }
    }, true);
    // 吞掉 fab 上 click/touch 事件的冒泡——防止传给页面/底部 iframe 元素（小屏点击 inspect 触发底部 hover popup）
    // 注意：不含 pointerdown/pointerup/pointermove——拖动依赖它们在 window 上的监听（onMove/onEnd）
    ['click', 'mousedown', 'mouseup', 'touchstart', 'touchend'].forEach(function (t) {
      ctx.fab.addEventListener(t, function (e) { e.stopPropagation(); });
    });
    // 吞掉 launcher UI（HUD/工具条/面板/弹窗等全部自有浮层）事件的冒泡——放行方案（尤其 click）只应作用于页面元素，
    // 我们自己的 UI 事件绝不能传到原网页：否则「全部放行」时点工具条 🔒 放行方案下拉切回默认，
    // 该点击冒泡到页面被『点外部关菜单』逻辑捕获 → 页面刚打开的菜单被收起（用户实测）。
    // 统一挂在 #__dbg_launcher 根（所有自有浮层都是其子级）：冒泡到根即 stopPropagation，页面监听器收不到；
    // 我们 UI 自身的 handler 都在元素/根内层（先于根执行），不受影响。
    // 注意：不含 pointermove/pointerup——fab/工具条/HUD 拖动依赖 window 上的 pointermove/up（onMove/onEnd）
    // mousedown 必须含：页面弹出菜单常用 document mousedown 关闭（点外部关菜单）——launcher UI 的 mousedown 若漏到页面，
    // 会关掉刚打开的菜单（inspect 流程：放行→点页面 + 弹菜单→点工具条放行按钮→菜单被关，用户实测）。fab 已吞 mousedown，根补齐。
    // 不含 pointercancel：四套拖拽（AI 窗拖动/缩放、fab、工具条、HUD）的结束监听都挂 window pointercancel——
    // 根若吞掉它，触屏滚动接管/系统手势触发 cancel 时结束监听收不到 → dragState 残留、窗口卡住（pad 实测“拖一下就卡住”）。
    ['mouseup', 'mousedown', 'click', 'dblclick', 'contextmenu', 'pointerdown',
     'touchstart', 'touchmove', 'touchend', 'touchcancel',
     'mouseover', 'mouseout', 'mousemove', 'wheel', 'keydown', 'keyup', 'focusin', 'focusout', 'input', 'change'].forEach(function (t) {
      ctx.root.addEventListener(t, function (e) { e.stopPropagation(); });
    });
    // mousedown 单独处理（capture 相位，先于 fab/工具条等内部 stopPropagation）：preventDefault 防止 launcher UI 点击把页面焦点夺走。
    // 页面弹出菜单常靠“输入框失焦关闭”（如会话管理器的标签编辑器 onBlur→setEditing(false)→整个 picker 卸载）：
    // 全部放行点开菜单后，点我们 🔒 放行下拉 → 页面输入框失焦 → onBlur → 菜单被关闭（用户实测）。
    // preventDefault 阻止默认聚焦行为（焦点留在页面输入框）；launcher 自己的输入框（selector 等）除外
    ctx.root.addEventListener('mousedown', function (e) {
      if (e.target && e.target.closest && e.target.closest('input, textarea, select')) return;
      try { e.preventDefault(); } catch (err) {}
    }, true);
    ctx.root.appendChild(ctx.fab);
    ctx.restoreFabPos(); // 挂载后恢复（宽高正确才能算物理锚点）
    // 样式完全应用后校正一次贴边锚点（rAF 后 offsetWidth/font 才是最终值——否则小屏首次位置可能偏右超屏）
    requestAnimationFrame(function () { if (ctx.fabEdge) ctx.refreshFabAnchor(); });
    // 兜底延迟重算："没有缩放"时 vv resize/scroll 事件不触发（scale 无变化），首次计算若 vv.scale 未就绪（=1）会用错 scale——
    //   位置错后永不重算 → 不可见。主动延迟多重算，确保 vv.scale/尺寸就绪后位置正确（pinch 后刷新"出来"即此机制）

    [150, 600, 2000].forEach(function (ms) { setTimeout(ctx.safeFabRefresh, ms); });
    window.addEventListener('load', ctx.safeFabRefresh);
    // 缩放/窗口变化监听：页面缩放时 counter-zoom 保持视觉位置；窗口物理变化时贴边锚点重算
    if (window.visualViewport) {
      // 缩放/pan 变化：重算贴边锚点（refreshFabAnchor——vv 首次就绪/scale 变化时修正初始错位）+ 应用视觉位置
      window.visualViewport.addEventListener('resize', function () { ctx.refreshFabAnchor(); ctx.applyFabView(); ctx.applyToolbarZoom(); ctx.applyToolbarCompact(); ctx.applyHudZoom(); ctx.applyAiState(); });
      window.visualViewport.addEventListener('scroll', function () { ctx.refreshFabAnchor(); ctx.applyFabView(); ctx.applyToolbarZoom(); ctx.applyToolbarCompact(); ctx.applyHudZoom(); ctx.applyAiState(); });
    }
    window.addEventListener('resize', function () {
      ctx.refreshFabAnchor(); // 视口改变一律重算贴边锚点 + clamp（含 mobile 模拟 scale≠1：旧位置会超屏，必须重算）
      ctx.applyToolbarZoom();
    });

    // ---------------- 目标 = 宿主 + 宿主真实 iframe（阶段 3：无自建预览） ----------------
  ctx.aiIframe;
  ctx.inspectorOn = false;
  ctx.hudHoverOn = false; // HUD 模拟 hover 开关（真实事件派发，pin 在当前元素）
  ctx.pendingCommands = {};   // requestId -> {resolve, reject}（AI 命令往返）

    // ---------------- 页面调速/拦截选项（动画减速/事件拦截/定时器慢放） ----------------

  ctx.optState = Object.assign({
      animSpeed: 1, blockScroll: false, blockWheel: false, slowTimers: 1,
      netDelay: 0, netOffline: false, darkMode: false, reducedMotion: false,
      timeOffsetMs: 0, viewportW: 0, simulateTouch: false,
      dangerAutoOkMs: 30000, // 危险命令无人值守默认 30s：确认卡弹出后无响应 30s 自动允许执行（调速面板可改 0/10/30/60s）
    }, ctx.loadOptState());
  ctx.errLog = []; // 页面错误日志（捕获现场用，上限 20）
  ctx.aiInspectActive = false; // AI 窗口点选模式（选择元素回传 AI 窗，不弹窗可连续选）
  ctx.selfEngaged = false;     // 宿主页选区锁定（AI 点选确认时区分回传宿主/target）
  ctx.lastSelfPayload = null;  // 宿主页最近选区 payload（hover/engaged 消息自带——回传 AI 窗用）
  ctx.speedPanel = null;




    /** 确保目标 iframe 已创建且注入完成（自检/测试用） */


    // 强制校验 client 是最新版（防旧版残留——缺退出清理/新能力导致退出后仍可点选）
    // 旧版实例：exitInspector 清理监听 + 删除 + 重注入最新 MINI_DBG_CLIENT




    // ---------------- 危险命令用户确认（AI 经 postMessage 模拟 CDP 时，破坏性/持久类命令需用户批准） ----------------
;
    // 浏览器受限操作：程序化执行会被拦截，必须用户真实点击提供 user activation（每次都要，不可“记住”）
;
  ctx.gestureCard = null;
  ctx.sessionDangerOk = false; // “本次会话记住”——勾选后本会话危险命令不再逐个确认
  ctx.confirmCard = null;
  ctx.simReqN = 0;
  ctx.dangerQueue = [];     // 危险命令确认队列（并发时逐个确认，防止确认卡互相覆盖）
  ctx.confirmingDanger = false;

    /** AI 命令入口（含危险确认/手势桥）：dbg_command 消息 / simulateAiCommand / MCP 桥共用，返回结果 promise */


    // Browser 命令在宿主执行：手势卡点击发生在宿主（有 transient activation），target iframe 内无手势会被浏览器拒绝








    // 放行方案（多态）：默认=当前方案（只锁 click/hover）；全放行（含 click）/ 全冻结 / 自定义 p1-p3（调速面板管理）
    // 放行方案：内置（默认/全放行/全冻结，不可删）+ 用户自定义（方案名+内容可增删改，localStorage 持久化）
  ctx.RELEASE_PROFILES = {
      default: { name: 'default', label: '⚡ 默认放行',   release: ['key', 'wheel', 'scroll', 'touch', 'focus'], builtin: true },
      all:     { name: 'all',     label: '⚡⚡ 全部放行', release: ['click', 'hover', 'key', 'wheel', 'scroll', 'touch', 'focus'], builtin: true },
      frozen:  { name: 'frozen',  label: '⛔ 全部冻结', release: [], builtin: true },
    };
    // 默认放行类别用户可编辑（持久化；默认 = 除 click/hover 外全放行）

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
  ctx.userProfileSeq = 0; // 生成唯一 name






  ctx.currentProfile = 'default';


  ctx.toolbarHovering = false; // 鼠标在工具条上：冻结位置，允许点击（避免跟随死循环）
    // 底部信息条（HUD）：hover 快选时实时显示备选元素信息 + 点击提示（参考 Chrome inspector）
  ctx.hud = null;
  ctx.hudUserPos = null; // HUD 用户拖动固定位置（不跟随选区；退出 Inspector 重置）

 // 退出 Inspector 重置（恢复跟随选区）

  ctx.lastHud = null; // 最近 hover 数据（resize 重定位用——setHovered 同元素短路时不重新 post）

    window.addEventListener('resize', function () {
      // 视口变化（小屏/窗口缩放）→ HUD 重新定位（保持显示全——setHovered 同元素短路不重新 post）
      if (ctx.hud && ctx.hud.style.opacity === '1' && ctx.lastHud) {
        if (!ctx.hudUserPos) ctx.updateHud(ctx.lastHud.p, ctx.lastHud.source);
        else {
          // 拖动固定位置也 clamp 视口内（视觉 px——避免缩放后超视口隐藏）
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

    // HUD counter-zoom：按真实屏幕尺寸（visualViewport.scale × inner = 物理视口）——页面缩放时视觉尺寸/位置固定





    // 工具条跟随选区悬浮（选区上方，避开手指/鼠标）
  ctx.toolbarDragged = false; // 用户拖动工具条后：位置优先保持（选区变化才智能贴合）
  ctx.lastSelRect = null;     // 上次选区 rect（拖动后比较：同选区不移动，新选区贴合）

    // 重新贴合工具条（# 弹窗开/关后工具条高度变化 → 避让重算；不触发拖动保持逻辑）

    // 工具条 counter-zoom：页面缩放时反向缩放 + 位置÷scale，视觉尺寸/位置固定（不跟着页面缩放）

    // ---- 工具条鼠标拖动（按住非按钮区域如选区信息条）：拖动后位置优先；选区变化自动贴合 ----
    // 注意：不能用工具栏构建子函数里的 toolbar 变量（window.toolbar 是 BOM 对象），一律动态查找

    ctx.attachToolbarDrag();


    // ---------------- 调速/拦截面板（动画减速/事件拦截/定时器慢放） ----------------



    // ---------------- 一份 client 注入宿主自身 + 递归注入同源 iframe（self-inspect 双区统一） ----------------
    // 宿主页与 iframe 用同一份 MINI_DBG_CLIENT：宿主页以 __DBG_POST__ 回调模式执行；iframe 走 parent.postMessage
  ctx.selfClient = null; // 宿主页自身的 client 实例
  ctx.selfClientActive = false; // 🖥 按钮独立激活状态


    // 注入单个同源 iframe：未加载等 load，注入后递归其子页面

    // 注入所有同源 iframe（子页面一次都被注入；AI iframe 跳过）

    // 持续监听：每个已注入的文档（宿主 + 各 iframe）都观察，动态添加的 iframe 自动注入（链式）






    // 现场快照：错误列表 + 模拟条件 + 页面状态 → 发给 AI


    // ---------------- AI 悬浮窗（aiUrl；可拖拽/贴边/自由调宽高，位置记忆 localStorage） ----------------
  ctx.aiReady = false;
  ctx.aiQueue = [];
  ctx.aiWin = null;
  ctx.aiState = null;







    // AI 窗是否在屏内可见（视觉面积>40%）——旧数据/视口变化导致超屏/不可见时重置默认






    // 允许连接后绑定 AI iframe URL：桥地址+token 注入 AI 窗（ai.html 读参数显示状态，供路径 1 桥→AI 窗→页面）


    // ---------------- 系统日志（AI 主窗口 = ai.html：对话 + CDP 模拟一体化；日志转发 AI 窗口显示） ----------------


    // ---------------- 消息路由：宿主 ⇄ 目标UI ⇄ AI（全部异步 postMessage） ----------------



    /** AI 命令经宿主转发给目标 UI，requestId 关联异步结果后原路返回 */

    ctx.execInPage._n = 0;





    // ---------------- 开关 ----------------

    ctx.aiBtn.addEventListener('click', ctx.toggleAi);

    // ---------------- Inspector：三步点选 + 选区微调（桌面 hover / 触屏点击移动） ----------------

    // 触屏：压掉按钮 :hover 残留（点击后不形成'hover整个窗口'错乱视觉）——不依赖工具条就绪
    ctx.root.classList.toggle('dbg-touch-ui', isTouchDevice());
    // 小屏检测（分级）：目标页可能未适配小屏，但我们的工具条自主检测并放大
    //   compact = 视口<768 或触屏 → 按钮 38px/16px；touch = 触屏或视口<480 → 按钮 44px/18px（触控目标标准）



    ctx.root.classList.toggle('dbg-touch-ui', isTouchDevice()); // 触屏：压掉按钮 :hover 残留（点击后不'hover整个窗口'）
    window.addEventListener('resize', function () { ctx.applyToolbarCompact(); });
    // Inspect 打开后延迟 1s 扫描：列出覆盖视口大的 fixed/透明层（定位'浅蓝全窗遮罩'来源）→ 顶部弹独立可复制框 + console
    // body/html 染色属性诊断（用户：'body 被附近属性导致淡蓝、删 body 重建才好'）——不弹大框，只右上角小角标，可复制

    // 独立兜底：移除 target 文档残留的选区框 div（纯 DOM 操作，无递归；即使 exitInspector 内部异常也调用）



    ctx.inspBtn.addEventListener('click', function (e) { e.stopPropagation(); ctx.inspectorOn ? ctx.exitInspector() : ctx.enterInspector(); });

    // 激活/退出宿主页内同源 iframe 的 client（嵌套——AI 点选/Inspector 可选中 iframe 内元素；launcher 内 target/AI 排除）



    // ---------------- 预览 + 勾选 + 指示 弹窗（第三步） ----------------
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

    // 预览区：元素摘要（确认选中的是什么）
  ctx.preview = el('div', { class: 'dbg-preview' });
    ctx.dBody.appendChild(ctx.preview);

    // 勾选区：哪些信息带给 AI（R7 可选）
  ctx.checks = el('div', { class: 'dbg-checks' });
  ctx.checkDefs = [
      ['text', '文本'], ['computed', '样式'], ['attrs', '属性'], ['xpath', '定位'], ['framework', '框架/文件位置'],
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
  ctx.dCancel = el('button', { class: 'dbg-ghost' }, ['取消']);
  ctx.dSend = el('button', { class: 'dbg-primary' }, ['发送给 AI']);
    ctx.dFoot.appendChild(ctx.dCancel);
    ctx.dFoot.appendChild(ctx.dSend);
    ctx.cardDlg.appendChild(ctx.dHead);
    ctx.cardDlg.appendChild(ctx.dBody);
    ctx.cardDlg.appendChild(ctx.dFoot);
    ctx.dialog.appendChild(ctx.cardDlg);
    ctx.root.appendChild(ctx.dialog);



  ctx.lastPayload = null;

    ctx.dClose.addEventListener('click', ctx.closePreview); // 预览关闭 → 返回工具条（不退出 inspect——用户要求预览为可选）
    ctx.dCancel.addEventListener('click', ctx.closePreview);

    ctx.dSend.addEventListener('click', function () {
      if (!ctx.lastPayload) return;
      ctx.closeDialog();
      // 确保 AI 窗存在（否则 postToAi 丢弃——候选发不出去）
      try { ctx.ensureAi(); ctx.showAi(true); ctx.aiOpen = true; ctx.aiBtn.classList.add('dbg-on'); } catch (e) {}
      // host 🎯 inspect 发送给 AI：走扩展可处理路径（dbg_ai_element 候选 → pi-web 输入框 [元素N]）——
      //   原 sendToAi(db_user_message) 到 pi-web 被扩展丢弃（用户实测"点击发送到AI发不过来"）
      try { ctx.picksAddElement(ctx.enrichElPayload ? ctx.enrichElPayload(ctx.lastPayload) : ctx.lastPayload); }
      // 兜底 catch（picksAddElement 异常才走）：本设备是「host 发元素给 AI」，归属恒为 AI（_selfAttrib:false）——
      // 即使此刻 selfAiRequested 被干扰，也强制发到 AI 窗，不落 host self。
      catch (e) { ctx.postToAi({ type: 'dbg_ai_element', _selfAttrib: false, payload: ctx.lastPayload }); }
      ctx.addMsg('sys', '已发送选中元素（' + ctx.lastPayload.tag + '）给 AI——输入框已放入 [元素N]，点发送即达。');
    });

    // ---------------- 全局消息入口（宿主 ⇄ 目标UI / AI） ----------------
    // hover 调试面板：hover 生效或被抑制/排除时显示细节，可复制（用户贴给 AI 分析'蓝框圈住整页'场景）



    window.addEventListener('message', ctx.onHostMessage);

    // 键盘导航：工具条显示（engaged 锁定）时拦截快捷键自己用；非 Inspector / hover 快选放行页面
;
    // 键盘处理共用（宿主 + target iframe 转发）：工具条显示（锁定态）时拦截快捷键自己用；非锁定放行页面

    document.addEventListener('keydown', function (e) { ctx.hostKey(e); });
    // target iframe 内键盘：点选 iframe 元素后键盘焦点在 iframe（宿主 document keydown 收不到——"完全没有监听键盘事件的感觉"）
    // 注意：iframe 由 ensureTarget() 创建（本块在其前）——绑定调用在尾部 ensureTarget() 之后执行 + load re-bind


    // 销毁：移除消息监听 + 整个浮层（测试中心切换框架用）


    // ---------------- 暴露句柄 ----------------
    // ---- 工具条构建（阶段 3：独立于任何 iframe；选区定向按 selFrameId） ----
    try { ctx.buildToolbar(); } catch (e) {}
    // ---- AI 窗口预创建（隐藏 + iframe 预加载，打开即就绪）+ 刷新记忆恢复 ----
    // 生命周期：launcher 加载即创建 AI 窗（iframe 预热），但默认隐藏（CSS .dbg-ai-win{display:none}）；
    //   仅当"上次关前开着"（dbgState.aiOpen）或用户点 AI 按钮时才显示
    // 新窗口模式恢复：先置恢复标志——ensureAi 弹窗分支见标志不立即 window.open（同名窗口会被复用并导航，弹窗会话丢失），
    //   改等弹窗心跳 adopt（10s 定时器兜底：无心跳才 openAiPopup）
    try { ctx._restoringPopup = !!(ctx.dbgState.aiOpen && (ctx.loadAiState ? (ctx.loadAiState().mode === 'popup') : false)); } catch (e) { ctx._restoringPopup = false; }
    if (ctx.selfHostPage) {
      ctx.aiOpen = false; // self 宿主页：跳过 AI 窗预创建与刷新恢复——页面自身即 AI 窗，再建一个是嵌套冗余
    } else {
    try { ctx.ensureAi(); } catch (e) {}
    if (ctx.dbgState.aiOpen) {
      if (ctx.aiMode === 'popup') {
        // 新窗口模式恢复：宿主刷新后 ctx.aiPopup 句柄丢失，但弹窗的 window.opener 仍指向本窗口（跨刷新保留）——
        // 先等弹窗心跳（aiti-client 每 5s 发 dbg_ai_ready）→ handleClientMessage 自动 adopt e.source 重建引用，
        // 弹窗不重载、会话不丢。若 10s 无心跳（弹窗已关/导航走了）→ window.open 同名窗口：还在则复用回收（导航回 AI URL），
        // 不在则新建（无用户手势多半被拦 → openAiPopup 内部回退内嵌）
        ctx.aiOpen = true;
        ctx.aiBtn.classList.add('dbg-on');
        ctx.saveDbgState();
        ctx.addMsg('sys', '🔄 正在恢复 AI 独立窗口（等待窗口回应…）');
        setTimeout(function () {
          try {
            if (ctx.aiPopup && !ctx.aiPopup.closed) { ctx.showAi(true); return; } // 心跳已认领，弹窗未重载
            ctx._restoringPopup = false;
            ctx.openAiPopup(); // 无心跳 → 弹窗已关/未开：同名复用或新建（被拦截 → openAiPopup 内部回退内嵌）
          } catch (e) {}
        }, 10000);
      } else {
        try {
          ctx.showAi(true);
          ctx.aiOpen = true;
          ctx.aiBtn.classList.add('dbg-on');
          ctx.addMsg('sys', '🔄 已恢复调试会话（刷新前 AI 窗口开着，现已自动重开）。');
        } catch (e) {
          ctx.addMsg('sys', '⚠ AI 窗口自动恢复失败：' + ((e && e.message) || e) + '（可在 AI 窗口就地反馈给 AI 修复）');
        }
      }
    }
    }
    ctx.saveDbgState(); // 首次写入状态（含当前配置）

    // ---- 加载完成 toast：显示识别的大小屏信息（调试：真机上核对 screen/视觉视口/判定）----
    // 2026-08 重新打开（本轮修复 scaleY/transform 等比后，真机验证用；不需要时改回 if (false)）
    // ---- 调试信息窗口（替代临时 toast）+ 设置（AI 窗头部 ⚙）----
    // 持久化：是否刷新时自动显示调试信息（默认开；关闭后下次不再自动弹，仍可从设置里手动查看）

 // 默认关：on-load 不自动弹 debug 卡（会盖住页面）


    // 调试信息文本（screen/inner/vp/fab/AI）——复制给 AI 协助诊断

    // 居中卡片定位（小屏 counter-zoom 内容可读；桌面常规）

  ctx.debugPanel = null;

    // 设置弹窗（AI 窗头部 ⚙ 触发）：调试信息自动显示开关 + 手动查看

    // 刷新时自动显示调试信息窗口（可在设置/调试窗里关闭；关闭后下次不再自动弹）
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
      applyProfile: ctx.applyProfile, // 放行方案切换（default/all/p1/p2/p3/frozen）
      applyViewport: function (v) { ctx.optState.viewportW = v; ctx.saveOptState(); ctx.saveDbgState(); ctx.applyOptsToTarget(); }, // 视口模拟（改 iframe 宽度）
      open: ctx.toggleAi, sendMessage: ctx.sendText, execInPage: ctx.execInPage,
      // 目标路由层（方案 C）：T_HOST / listFrames / frameClient / postToFrame
      T_HOST: ctx.T_HOST, listFrames: ctx.listFrames, frameClient: ctx.frameClient, postToFrame: ctx.postToFrame, selFrameId: ctx.selFrameId, currentFrameId: ctx.currentFrameId,
      openAi: function () { ctx.aiOpen = true; ctx.ensureAi(); ctx.showAi(true); ctx.aiBtn.classList.add('dbg-on'); ctx.saveDbgState(); }, // 自动弹 AI 窗（不退出 Inspector，与 toggleAi 互斥逻辑区分）
      postToAi: ctx.postToAi, broadcast: ctx.broadcast,
      // 兼容：targetWindow() = 第一个宿主 iframe 的 window（hub 摆的目标页）
      targetWindow: function () { return (ctx.listFrames()[0] || {}).win || null; },
      captureSceneSend: ctx.captureSceneSend,
      simulateAiCommand: function (cmd, args) {
        return ctx.handleAiCommand({ cmd: cmd, args: args || {}, requestId: 'sim_' + (++ctx.simReqN) });
      }, // 模拟 AI 发命令（含危险确认）；自检/测试用
      destroy: ctx.destroy,
    };
    // 防嵌套兑底观察窗：启动时共享库特征可能还没加载出来（aiti-client/host-protocol 均晚于 defer script），
    // 且业务路由可能清洗掉 _dbg 参数——启动后短窗内轮询，特征一出现立即自毁（UI/预创建的 AI 窗 iframe 一并移除，
    // 防 dev ai 里套 prod ai 的逐层嵌套拖死主线程）
    var _nestN = 0, _nestIv = setInterval(function () {
      _nestN++;
      if (aiWindowMarkers()) {
        clearInterval(_nestIv); _nestIv = null;
        try { if (window.console && console.warn) console.warn('[aiti] 运行期检测到 AI 窗特征——launcher 自毁（防嵌套）'); } catch (e) {}
        try { ctx.destroy(); } catch (e) {}
        try { if (ctx.aiIframe) { ctx.aiIframe.src = 'about:blank'; ctx.aiIframe.remove(); ctx.aiIframe = null; } } catch (e) {}
        try { var _r = document.getElementById('__dbg_launcher'); if (_r && _r.parentNode) _r.parentNode.removeChild(_r); } catch (e) {}
      } else if (_nestN > 40) { clearInterval(_nestIv); _nestIv = null; } // 10s 后停轮询
    }, 250);

    return ctx.root.__dbgLauncher;
}
