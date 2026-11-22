// 视口/设备工具（自 dbg-launcher.js 闭包提取，全部纯函数，只依赖全局对象）
export function getPhysViewport() {
      var scale = 1, hasVV = false;
      try {
        hasVV = !!window.visualViewport && window.visualViewport.scale > 0;
        if (hasVV) scale = window.visualViewport.scale;
        // 防御：scale 必须是有穷正数（无缩放/缺失/异常时 vv.scale 可能 undefined/NaN/0/Infinity）
        if (!isFinite(scale) || scale <= 0) { hasVV = false; scale = 1; }
      } catch (e) { hasVV = false; scale = 1; }
      var w = window.innerWidth * scale;
      var h = window.innerHeight * scale;
      try {
        var scr = getPhysScreen();
        var sw = scr.w, sh = scr.h;
        if (sw > 0 && window.innerWidth > sw + 50) {
          // 移动无 meta：屏边界 = 屏 CSS 宽/高（恒，贴边/clamp 不随 pinch 漂）
          var sBase = (sw > 0 && window.innerWidth > 0) ? sw / window.innerWidth : 1;  // 默认缩放（恒）
          var syBase = (window.innerHeight > 0 && sh > 0) ? sh / window.innerHeight : sBase; // 默认纵向（非等比）
          scale = sBase;
          var scaleY = syBase;
          // 跟随 pinch：vv.scale 反映当前缩放（默认=sBase；pinch 时变）→ counter-zoom/位置跟随，
          //   fab/AI 物理屏位置恒定不漂。纵向保持非等比 × pinch 因子
          try {
            var vvs = window.visualViewport && window.visualViewport.scale;
            if (hasVV && isFinite(vvs) && vvs > 0) { var pinch = vvs / sBase; scale = vvs; scaleY = syBase * pinch; }
          } catch (e) {}
          if (!isFinite(scale) || scale <= 0) scale = sBase;
          if (!isFinite(scaleY) || scaleY <= 0) scaleY = scale;
          w = sw; h = sh;
          return { w: w, h: h, scale: scale, scaleY: scaleY };
        }
      } catch (e) {}
      return { w: w, h: h, scale: scale, scaleY: scale };
    }

export function detectCoordSemantics(el, clientX) {
      try {
        var vp = getPhysViewport();
        var r = el.getBoundingClientRect();
        var dLayout = Math.abs(clientX - r.left);          // 假设 clientX 布局
        var dVisual = Math.abs(clientX - r.left * vp.scale); // 假设 clientX 视觉
        return dLayout < dVisual; // true = clientX 布局坐标（需 ×scale 转视觉）
      } catch (e) { return false; }
    }

export var _fixedVisual = (function () {
      var ua = String(navigator.userAgent || '');
      var pf = String(navigator.platform || '');
      // UA 含 iOS 字样 + 平台确为 iOS（真机）→ fixed 相对 visual viewport；
      // 模拟/远程 Chrome 只改 UA 不改 platform（如 Linux x86_64）→ 判定 layout（避免 visual 分支在 layout 内核错位"中间"）
      return /iPhone|iPad|iPod/i.test(ua) && (/iPhone|iPad|iPod/i.test(pf) || /MacIntel/i.test(pf));
    })();

export function positionPhysical(el, visX, visY, scale, scaleY) {
      // 防御：依赖值不存在/出错（undefined/NaN/Infinity）→ 回退默认（0 位置 + scale=1），避免 left:NaNpx 元素不可见
      if (!isFinite(visX)) visX = 0;
      if (!isFinite(visY)) visY = 0;
      if (!isFinite(scale) || scale <= 0) scale = 1;
      if (!isFinite(scaleY) || scaleY <= 0) scaleY = scale;
      if (_fixedVisual) {
        // iOS visual 语义：fixed 相对 visual viewport——left/top 直接视觉值；
        // 关键：不加 transform counter-zoom——iOS fixed 元素天然保持视觉 CSS 尺寸（相对 visual viewport），
        //   fixed+transform 在 iOS 页面缩放时渲染错乱（scale≈0.4 时整窗不可见，pinch 后刷新恢复——用户实测）
        el.style.transform = '';
        el.style.transformOrigin = '';
        el.style.left = visX + 'px';
        el.style.top = visY + 'px';
        return;
      }
      var offX = 0, offY = 0;
      try {
        var vv = window.visualViewport;
        if (vv) { offX = vv.offsetLeft || 0; offY = vv.offsetTop || 0; }
      } catch (e) {}
      if (Math.abs(scale - 1) < 0.01 && offX === 0 && offY === 0 && Math.abs(scaleY - 1) < 0.01) {
        el.style.transform = '';
        el.style.left = visX + 'px';
        el.style.top = visY + 'px';
      } else {
        // counter-zoom 恒等比（scale(1/scale)）：非等比 transform（如 scale(2.526,2.067)）拉伸图标——
        //   华为真机实测"图标压扁，宽度比高度大"（fixed 实际等比渲染，非等比 transform 过度补偿）
        //   位置换算保留 scaleX/scaleY 分开（top 按 scaleY——贴底/纵向位置已修正）
        el.style.transform = 'scale(' + (1 / scale) + ')';
        el.style.transformOrigin = 'top left';
        el.style.left = (visX / scale + offX) + 'px';
        el.style.top = (visY / scaleY + offY) + 'px';
      }
    }

export function visToCss(visW, visH, scale, scaleY) {
      if (!isFinite(scale) || scale <= 0) scale = 1;
      if (!isFinite(scaleY) || scaleY <= 0) scaleY = scale;
      return { w: visW, h: _fixedVisual ? visH : visH * scale / scaleY };
    }

export function capVisW(vp, margin) {
      return Math.max(160, (vp.w > 0 ? vp.w : window.innerWidth) - margin); // vp.w（屏宽，恒）——不用 vv.width（pinch 时变窄会错夹）
    }

export function capVisH(vp, margin) {
      return Math.max(120, (vp.h > 0 ? vp.h : window.innerHeight) - margin);
    }

export function placePhysBox(el, visX, visY, visW, visH, scale, scaleY) {
      var c = visToCss(visW, visH, scale, scaleY);
      el.style.width = c.w + 'px';
      el.style.height = c.h + 'px';
      positionPhysical(el, visX, visY, scale, scaleY);
    }
export function placePhysPanel(el, opts) {
      opts = opts || {};
      var vp = getPhysViewport();
      var visW = opts.visW != null ? opts.visW : capVisW(vp, 0); // 默认全宽
      // 可视视觉高（贴边基准 + 高度上限）——输入法弹出（visualViewport 收缩）时收缩，
      //   dock:bottom 面板重定位到键盘上方（配合 _trackPhysPanel 的 resize 重放）
      var _vvH = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
      var visVh = _fixedVisual ? _vvH
                               : Math.min(window.innerHeight * vp.scaleY, Math.max(0, _vvH) * vp.scaleY);
      // 高度：给定值或自适应内容高（先限宽再量 scrollHeight，CSS px → 视觉 px）
      var visH = opts.visH;
      if (visH == null) {
        el.style.maxWidth = visW + 'px';
        el.style.width = '';
        el.style.height = '';
        var cssH = el.scrollHeight || el.offsetHeight || 60;
        visH = _fixedVisual ? cssH : cssH * vp.scaleY / vp.scale;
      }
      visH = Math.min(Math.max(visH, opts.minH != null ? opts.minH : Math.round(visVh * 0.3)),
                      opts.maxH != null ? opts.maxH : Math.round(visVh));
      var dock = opts.dock || 'bottom';
      var gap = opts.gap != null ? opts.gap : 0;
      var visY = dock === 'top'
        ? Math.max(0, gap)
        : Math.max(0, Math.round(visVh - visH - gap - (opts.offsetY || 0)));
      var visX = opts.visX != null ? opts.visX : Math.max(0, Math.round((vp.w - visW) / 2));
      // 清残留（四边 auto + transform + 限宽高 + 可选 border/borderRadius）——避免小屏/大屏分支切换后残留旧值
      el.style.minWidth = '0';
      el.style.maxWidth = opts.maxWidth != null ? opts.maxWidth : 'none';
      el.style.maxHeight = opts.maxHeight != null ? opts.maxHeight : 'none';
      el.style.overflowY = opts.overflowY != null ? opts.overflowY : 'auto';
      if (opts.border !== undefined) el.style.border = opts.border;
      if (opts.borderRadius !== undefined) el.style.borderRadius = opts.borderRadius;
      el.style.left = 'auto'; el.style.right = 'auto'; el.style.bottom = 'auto'; el.style.top = 'auto';
      el.style.transform = '';
      placePhysBox(el, visX, visY, visW, visH, vp.scale, vp.scaleY);
      // 键盘自适应：注册面板——visualViewport resize（输入法弹/收）时重放重定位，
      //   贴到键盘上方；keyboard:false 跳过（AI 窗等自管窗口不抢位置）
      if (opts.keyboard !== false) _trackPhysPanel(el, opts);
      return { visX: visX, visY: visY, visW: visW, visH: visH };
    }

export function getPhysScreen() {
      try {
        if (window.screen && window.screen.width) {
          var dpr = window.devicePixelRatio || 1;
          var sw = window.screen.width, sh = window.screen.height;
          // screen.width 单位判定（CSS vs 物理像素）：多信号交叉，避免平板（CSS 宽 ≥768）被老"物理误报修正"错除 dpr
          //   用户实测：华为平板 777×1108 CSS（旋转支架用）UA 含 "Android/Phone" → 触发物理修正 → 误判 270px 小屏、fab 屏中间
          //   信号① navigator.userAgentData.mobile=false → 平板/桌面：screen.width 就是 CSS，绝不修正（UA-CH 比 UA 字符串可靠）
          //   信号② outerWidth/availWidth（移动端恒 CSS）：与 screen.width 同量级 → CSS；≈screen.width/dpr → screen 是物理（老 WebView）
          //   信号③ 兜底：UA-CH 手机 或 UA 判手机 且 sw/dpr<768 → 老规则修正
          var isPhone = null;
          try {
            var uad = navigator.userAgentData;
            if (uad && typeof uad.mobile === 'boolean') isPhone = uad.mobile;
          } catch (e) {}
          var needFix = false;
          if (sw >= 768 && dpr >= 1 && isPhone !== false) {
            // ① screen.width > layout 视口宽（innerWidth，no-meta 移动=980）→ screen 报物理像素（CSS 屏宽不可能大于 layout）——最可靠且 pinch 安全
            //   外部 cssLike（outerWidth）也可能同报物理 → sw/cssLike≈1 误判 CSS；over-layout 兜住这类。
            //   【修正】仅键盘弹出（innerHeight 收缩）时 innerWidth 不变，但加上屏宽 vs 可视宽冗余比较
            //   会误触发（华为 pad 777×1108 弹键盘 669 → 777>719 判“物理” → 777/2.875=270 误判小屏）。
            //   过-layout 判据加上余量双重确认：innerWidth 至少比 sw 小 25%（键盘/分屏都不会让宽差这么多）
            if (window.innerWidth > 0 && sw > window.innerWidth + 50 && sw > window.innerWidth * 1.25) needFix = true;
            else {
              var cssLike = 0;
              if (window.outerWidth && window.outerWidth > 0) cssLike = window.outerWidth;
              else if (window.screen.availWidth && window.screen.availWidth > 0) cssLike = window.screen.availWidth;
              if (cssLike > 0) {
              // 【pad 误判修复】cssLike≈sw（比值<1.05）说明 screen 就是 CSS 像素——强制不修正。
              // 华为 pad 777×1108 CSS、UA 含 "Phone; OpenHarmony"（无 UA-CH 时 isMobileUA()=true）
              // 曾被 over-layout 信号误除 dpr → 777/2.875=270 假小屏（角柄/拖动全隐藏“缩放功能没了”）。
              if (sw / cssLike < 1.05) needFix = false;
              else needFix = (sw / cssLike) >= 1.4; // 外部 CSS 宽明显更窄 → screen 报物理
            } else if (isPhone === true || isMobileUA()) needFix = (sw / dpr) < 768; // 无外部信号：UA 手机规则
          }
          }
          if (needFix) { sw = sw / dpr; sh = sh / dpr; } // 物理→CSS（老 Android WebView 1080/dpr3 → 360）
          return { w: sw, h: sh, dpr: dpr };
        }
      } catch (e) {}
      return { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 };
    }

export var _isMobileUA = null;

export function isMobileUA() {
      if (_isMobileUA === null) {
        try {
          var uad = navigator.userAgentData;
          if (uad && typeof uad.mobile === 'boolean') {
            _isMobileUA = uad.mobile; // UA-CH 权威：平板/桌面 false（UA 字符串常误导，如 "Phone; OpenHarmony"）
          } else {
            var ua = String(navigator.userAgent || '');
            _isMobileUA = /Mobile|Android|iPhone|iPod|Windows Phone|webOS|IEMobile|Silk/i.test(ua);
          }
        } catch (e) { _isMobileUA = false; }
      }
      return _isMobileUA;
    }

export function detectScreenMode() {
      var scr = getPhysScreen(); // 已做物理像素修正（返回 CSS 屏宽）
      var vp = getPhysViewport();
      var d = scr.w;
      return {
        small: d < 768, tiny: d < 480,
        deviceCssW: Math.round(d), screenW: Math.round(scr.w), screenH: Math.round(scr.h),
        dpr: scr.dpr, vpW: Math.round(vp.w), vpH: Math.round(vp.h), scale: vp.scale,
        mobileUA: isMobileUA()
      };
    }

export function isTouchDevice() {
      return ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
    }

export function isSmallScreen() {
      return detectScreenMode().small || isTouchDevice(); // 设备物理尺寸 + mobile UA 兜底——用户缩放不影响；layout=980 不误判
    }

export function isTouchCompact() {
      return isTouchDevice() || detectScreenMode().tiny;
    }

// —— 键盘自适应（输入法弹/收）——
// 所有 placePhysPanel 面板（user_* 弹窗/确认窗/预览弹窗）自动跟随 visualViewport
// 收缩：键盘弹出时重定位贴键盘顶（防遮挡），收起回原位。单个全局监听 + isConnected
// 清理，调用方无需各自绑定/移除（AI 窗等自管窗口经 opts.keyboard:false 跳过）。
var _physPanels = new Set(); // { el, opts }
var _vvWatchInstalled = false;
function _trackPhysPanel(el, opts) {
  if (!el) return;
  var found = false;
  _physPanels.forEach(function (t) { if (t.el === el) { t.opts = opts; found = true; } });
  if (!found) _physPanels.add({ el: el, opts: opts });
  _installVvWatch();
}
function _installVvWatch() {
  if (_vvWatchInstalled || !window.visualViewport) return;
  _vvWatchInstalled = true;
  var timer = null;
  window.visualViewport.addEventListener('resize', function () {
    if (timer) return; // 键盘动画连续 resize → 防抖
    timer = setTimeout(function () {
      timer = null;
      _physPanels.forEach(function (t) {
        try {
          if (!t.el || !t.el.isConnected) { _physPanels.delete(t); return; }
          placePhysPanel(t.el, t.opts);
        } catch (e) { /* 单面板失败不阻断其余 */ }
      });
    }, 60);
  });
}
