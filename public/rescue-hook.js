/* aiti-rescue-hook — dev 编译错误自动引导进急救页（crash-rescue 场景3）
 *
 * 触发条件（唯一）：dev overlay（<nextjs-portal>）出现且内容为 Build Error
 * （编译期错误，如 "Export xxx doesn't exist in target module"）。这类错误发生在
 * React 树建立之前，global-error.tsx（渲染期边界）结构上接不住；急救出口是
 * /rescue.html（public/ 静态页，不进编译图）。
 *
 * 注入路径（双保险，幂等）：
 *  ① pi-web app/layout.tsx 常驻 <script src="/rescue-hook.js" async> —— 覆盖
 *     「页面已打开，HMR 推到编译错」的场景（任何访问路径，含直连端口）；
 *  ② nginx /dev location sub_filter 注入 —— 覆盖「编译坏后全新加载」：500 错误页
 *     不含我们的 layout（模块图坏），只有 nginx 能把本钩子注进去。
 *
 * 行为：横幅 + 30s 倒计时自动跳 /rescue.html?err=<错误文本>；点按钮可立即进 /
 * 留在本页；overlay 消失（= AI 已修复，HMR 恢复）自动撤横幅取消倒计时。
 * 事件驱动（MutationObserver），零轮询；prod 无 dev overlay，本脚本天然惰性。
 * 手动入口（无钩子时）：直接访问 /dev/rescue.html。
 */
(function () {
  "use strict";
  if (window.__aitiRescueHook) return;
  window.__aitiRescueHook = true;

  if (/\/rescue\.html$/.test(location.pathname)) return; // 急救页自身不注入

  // base：/dev/xxx → /dev；/xxx → ""（prod 无 basePath）
  var BASE = /^\/dev(?=\/|$)/.test(location.pathname) ? "/dev" : location.pathname.replace(/\/[^\/]*$/, "");

  var COUNTDOWN = 30; // 秒；给「AI 正在改文件、马上修好」的暂态留余地
  var banner = null, timer = null, left = 0;
  // 「留在本页」的持久记忆：同一条错误点留后不再弹回（否则 overlay 在场时任何 DOM
  // 变动都会 check() → showBanner 立刻弹回 = 实际关不掉，2026-09-08 反馈）。
  // overlay 消失（错误被修好）时重置，下一条新错误照常提醒。
  var dismissedErr = null;
  // 注：原版顶部的 RE_BUILD_ERROR 变量声明已删——它从未被 check 流程引用（实际用的是 matchLine 内的 patterns）

  function removeBanner() {
    if (timer) { clearInterval(timer); timer = null; }
    if (banner) { banner.remove(); banner = null; }
  }

  function goRescue(errText) {
    location.replace(BASE + "/rescue.html?err=" + encodeURIComponent(errText || "Build Error（详情见 dev overlay）"));
  }

  function showBanner(errText) {
    if (dismissedErr === errText) return; // 用户已对这条错误选「留在本页」，不再打扰
    if (banner) {
      // 仅在变化时写入：textContent 赋值即使同值也会产生 childList mutation，
      // 会再触发下方 light observer → check() → showBanner → 无限循环锁死页面（E2E 实踩）
      if (banner._err.textContent !== errText) banner._err.textContent = errText;
      return;
    }
    // 右上角紧凑卡片：不横贯底边（此前 left:12px;right:12px 的全宽底栏正好压住
    // Next.js dev overlay 左下角的工具按钮，2026-09-08 反馈），标题栏可拖动。
    banner = document.createElement("div");
    banner.style.cssText = "position:fixed;top:12px;right:12px;width:440px;max-width:calc(100vw - 24px);z-index:2147483647;" +
      "background:#1a1a1a;color:#e8e8e8;border:1px solid #f59e0b;border-radius:10px;" +
      "padding:12px 14px;font:13px/1.5 system-ui,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.5);";
    var title = document.createElement("div");
    title.style.cssText = "font-weight:700;color:#f59e0b;margin-bottom:4px;cursor:move;user-select:none;display:flex;align-items:center;";
    title.textContent = "🚑 dev 编译错误 — 急救页可用";
    // 标题栏拖动（标题栏 = 拖拽把手；拖后改为 top/left 定位，不再跟随 right 锚点）
    title.onmousedown = function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      var r = banner.getBoundingClientRect();
      var ox = e.clientX - r.left, oy = e.clientY - r.top;
      banner.style.right = "auto";
      banner.style.left = r.left + "px";
      banner.style.top = r.top + "px";
      var move = function (ev) {
        banner.style.left = Math.max(0, Math.min(window.innerWidth - 40, ev.clientX - ox)) + "px";
        banner.style.top = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - oy)) + "px";
      };
      var up = function () {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    };
    var close = document.createElement("button");
    close.textContent = "✕";
    close.title = "留在本页（同一条错误不再提醒）";
    close.style.cssText = "margin-left:auto;background:transparent;color:#9ca3af;border:none;font-size:14px;cursor:pointer;line-height:1;";
    close.onclick = function () { dismissedErr = banner._err.textContent; removeBanner(); };
    title.appendChild(close);
    var err = document.createElement("div");
    err.style.cssText = "color:#9ca3af;margin-bottom:10px;max-height:3.2em;overflow:hidden;word-break:break-all;";
    err.textContent = errText;
    banner._err = err;
    var row = document.createElement("div");
    row.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;align-items:center;";
    var go = document.createElement("button");
    go.textContent = "进入急救页";
    go.style.cssText = "background:#f59e0b;color:#1a1a1a;border:none;border-radius:6px;padding:6px 14px;font-weight:600;cursor:pointer;";
    go.onclick = function () { removeBanner(); goRescue(errText); };
    var cd = document.createElement("span");
    cd.style.cssText = "color:#9ca3af;font-size:12px;";
    var stay = document.createElement("button");
    stay.textContent = "留在本页";
    stay.style.cssText = "background:#333;color:#e8e8e8;border:1px solid #444;border-radius:6px;padding:6px 12px;cursor:pointer;";
    stay.onclick = function () { dismissedErr = errText; removeBanner(); };
    row.appendChild(go); row.appendChild(stay); row.appendChild(cd);
    banner.appendChild(title); banner.appendChild(err); banner.appendChild(row);
    document.documentElement.appendChild(banner);
    left = COUNTDOWN;
    cd.textContent = left + "s 后自动进入";
    timer = setInterval(function () {
      left -= 1;
      if (left <= 0) { removeBanner(); goRescue(errText); return; }
      cd.textContent = left + "s 后自动进入";
    }, 1000);
  }

  // 穿透 shadow root 取文本（dev overlay 全在 shadow DOM 里）。
  // 性能闸（实测踩坑）：overlay 文本可能含超大单行（devtools 内联压缩 CSS ~10万字符），
  // 逐节点回调 + 每节点字符预算上限；配合 matchLine 的逐行线性扫描，
  // 避免 /([^\n]*X[^\n]*)/ 对巨串全文 match 的 O(n²) 回溯（实测单次 check 卡死主线程 4~90s）。
  // 注意：预算必须按节点独立 —— 共享预算会让文档序靠前的 portal（~10万字符）耗尽额度，
  // 导致排在后面的真正错误对话框被跳过（漏报，2026-09-06 审核实测）。
  var DEEP_TEXT_BUDGET = 256 * 1024; // 每节点最多扫这么多字符，Build Error 行不会藏得更深
  function deepText(node, cb) {
    if (!node || cb.done) return;
    if (node.nodeType === 3) {
      var s = node.textContent || "";
      if (s) { cb.chars += s.length; cb.lines.push(s); if (cb.chars > DEEP_TEXT_BUDGET) cb.done = true; }
      return;
    }
    if (node.shadowRoot) {
      var sr = node.shadowRoot.childNodes || [];
      for (var i = 0; i < sr.length; i++) deepText(sr[i], cb);
      if (cb.done) return;
    }
    var cn = node.childNodes || [];
    for (var j = 0; j < cn.length; j++) deepText(cn[j], cb);
  }

  // 关键：overlay 内容渲染在 portal 的 shadowRoot 内，插入后 shadow 内容再渲染**不会**
  // 触发 light DOM 的 MutationObserver —— 必须「light 发现 portal → 钻进 shadowRoot 再挂
  // 一层 observer」（仍是纯事件驱动，零轮询）。
  var shadowMo = new MutationObserver(function () { check(); });

  function watchPortalShadows() {
    var portals = document.querySelectorAll("nextjs-portal");
    for (var i = 0; i < portals.length; i++) {
      var p = portals[i];
      if (p.__hookShadowWatched || !p.shadowRoot) continue;
      p.__hookShadowWatched = true;
      shadowMo.observe(p.shadowRoot, { childList: true, subtree: true });
    }
  }

  // 检测范围：只扫 dev overlay 的容器（role=dialog / data-nextjs-dialog* / nextjs-portal），
  // **不能扫全页** —— 应用自己的聊天/会话摘要文本里可能出现 "Build Error" 字样（实测误报）。
  // deepText 同时覆盖 light childNodes 与 shadowRoot（实测 Next 16 的 Build Error 对话框是
  // body 下 light 元素直出；旧版本可能渲染在 portal shadow 里，双兼容）。
  function matchLine(text) {
    if (!text) return null;
    // 按特异性优先级取人类可读错误行；含花括号的行是 CSS/代码样式文本，跳过。
    // 语义与原版对齐：pattern 外循环（特异性优先）× 行内 test（线性无回溯）。
    // 不要用 /([^\n]*X[^\n]*)/ 对全文 match —— O(n²) 回溯，实测单次 check 卡死主线程 4~90s。
    var lines = text.split("\n");
    var patterns = [/doesn't exist in target module/i, /Failed to compile/i, /Build Error/i];
    var sawAny = false;
    for (var p = 0; p < patterns.length; p++) {
      for (var i = 0; i < lines.length; i++) {
        if (!patterns[p].test(lines[i])) continue;
        sawAny = true;
        var line = lines[i].trim();
        if (/[{}]/.test(line)) break; // 该 pattern 的首个命中行是 CSS/代码样式 → 换下一个 pattern
        return line.length > 200 ? line.slice(0, 200) + "…" : line;
      }
    }
    return sawAny ? "Build Error" : null;
  }

  // 防重入 + 尾随合并（保底防御；同步单线程下当前无重入路径）。
  // 逐节点独立扫描：每节点独立预算（见上），命中即停 —— portal 在文档序靠前也不得跳过后面的 dialog。
  var checking = false, pendingCheck = false;
  function check() {
    if (checking) { pendingCheck = true; return; }
    checking = true;
    try {
      watchPortalShadows();
      var nodes = document.querySelectorAll('[role="dialog"], [data-nextjs-dialog], [data-nextjs-dialog-overlay], nextjs-portal');
      if (!nodes.length) { dismissedErr = null; removeBanner(); return; }
      var line = null;
      for (var i = 0; i < nodes.length && !line; i++) {
        var cb = { chars: 0, lines: [], done: false };
        deepText(nodes[i], cb);
        line = matchLine(cb.lines.join("\n"));
      }
      if (line) showBanner(line);
      else { dismissedErr = null; removeBanner(); } // overlay 在场但非 Build Error（如 Console Error 弹窗）→ 不打扰
    } finally {
      checking = false;
      if (pendingCheck) { pendingCheck = false; setTimeout(check, 120); }
    }
  }

  var mo = new MutationObserver(function () { check(); });
  function start() {
    mo.observe(document.documentElement, { childList: true, subtree: true });
    check();
  }
  if (document.documentElement) start();
  else document.addEventListener("readystatechange", start, { once: true });
})();
