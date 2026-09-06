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
  var RE_BUILD_ERROR = /Build Error|Failed to compile|doesn't exist in target module/i;

  var banner = null, timer = null, left = 0;

  function removeBanner() {
    if (timer) { clearInterval(timer); timer = null; }
    if (banner) { banner.remove(); banner = null; }
  }

  function goRescue(errText) {
    location.replace(BASE + "/rescue.html?err=" + encodeURIComponent(errText || "Build Error（详情见 dev overlay）"));
  }

  function showBanner(errText) {
    if (banner) { banner._err.textContent = errText; return; }
    banner = document.createElement("div");
    banner.style.cssText = "position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483647;" +
      "background:#1a1a1a;color:#e8e8e8;border:1px solid #f59e0b;border-radius:10px;" +
      "padding:12px 14px;font:13px/1.5 system-ui,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.5);";
    var title = document.createElement("div");
    title.style.cssText = "font-weight:700;color:#f59e0b;margin-bottom:4px;";
    title.textContent = "🚑 dev 编译错误 — 急救页可用";
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
    stay.onclick = function () { removeBanner(); };
    row.appendChild(go); row.appendChild(stay); row.appendChild(cd);
    banner.appendChild(title); banner.appendChild(err); row.appendChild(cd); banner.appendChild(row);
    document.documentElement.appendChild(banner);
    left = COUNTDOWN;
    cd.textContent = left + "s 后自动进入";
    timer = setInterval(function () {
      left -= 1;
      if (left <= 0) { removeBanner(); goRescue(errText); return; }
      cd.textContent = left + "s 后自动进入";
    }, 1000);
  }

  // 穿透 shadow root 取文本（dev overlay 全在 shadow DOM 里）
  function deepText(node) {
    if (!node) return "";
    if (node.nodeType === 3) return node.textContent || "";
    var t = "";
    if (node.shadowRoot) {
      var sr = node.shadowRoot.childNodes || [];
      for (var i = 0; i < sr.length; i++) t += deepText(sr[i]);
    }
    var cn = node.childNodes || [];
    for (var j = 0; j < cn.length; j++) t += deepText(cn[j]);
    return t;
  }

  function check() {
    var portals = document.querySelectorAll("nextjs-portal");
    if (!portals.length) { removeBanner(); return; }
    for (var i = 0; i < portals.length; i++) {
      var text = deepText(portals[i]);
      if (RE_BUILD_ERROR.test(text)) {
        // 取错误首行做横幅摘要（太长的堆栈截断）
        var line = "";
        var m = text.match(/([^\n]*(?:doesn't exist in target module|Failed to compile|Build Error)[^\n]*)/i);
        if (m) line = m[1].trim();
        showBanner(line.length > 200 ? line.slice(0, 200) + "…" : (line || "Build Error"));
        return;
      }
    }
    removeBanner(); // portal 在但不是 Build Error（如 Console Error 弹窗）→ 不打扰
  }

  var mo = new MutationObserver(function () { check(); });
  function start() {
    mo.observe(document.documentElement, { childList: true, subtree: true });
    check();
  }
  if (document.documentElement) start();
  else document.addEventListener("readystatechange", start, { once: true });
})();
