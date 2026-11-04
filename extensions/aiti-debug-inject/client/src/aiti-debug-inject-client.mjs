// aiti-debug-inject client —— 极简：只注入目标 launcher JS，无 toolbar / 无弹窗
//
// 读两个 feature（extman 功能管理面板配）：
//   - inject.enabled（boolean，默认关）：注入开关
//   - service.url   （string）：目标 pi-web 服务地址
// 启用 + 有地址 → 把目标 pi-web 的 aiti-devtools launcher 注入本实例页面（带内容哈希版本号）→
//   本实例页面接入目标桥，目标 pi-web 的 agent 即可调试本实例页面（「用一个 pi-web 调试另一个」）。
// 不 registerItems、不渲染任何 UI——「就是简单注入 JS」。

export default function register(ctx) {
  if (typeof document === "undefined") return;

  const INJECT_FLAG = "data-aiti-debug-inject";
  let appliedKey = ""; // 当前已应用的目标 key（enabled+baseUrl），避免重复注入

  function injectLauncher(baseUrl) {
    const base = (baseUrl || "").replace(/\/+$/, "");
    if (!base) return;
    if (document.querySelector('script[' + INJECT_FLAG + '="' + base + '"]')) return; // 已注入该目标
    const launcherUrl = base + "/api/extensions/aiti-devtools/aiti-launcher.js";
    const versionUrl = base + "/api/extensions/aiti-devtools/launcher-version";
    const bridgeUrl = base + "/api/extensions/aiti-devtools/mcp";
    // 取目标 launcher 内容哈希拼 ?v=<hash>：目标 launcher 改动 → 强制拉新
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    fetch(versionUrl, { cache: "no-store", signal: ac.signal })
      .then((r) => r.json())
      .then((j) => (j && j.hash ? String(j.hash) : ""))
      .catch(() => "")
      .then((hash) => {
        clearTimeout(timer);
        if (document.querySelector('script[' + INJECT_FLAG + '="' + base + '"]')) return;
        const s = document.createElement("script");
        s.src = hash ? launcherUrl + "?v=" + encodeURIComponent(hash) : launcherUrl;
        s.dataset.bridgeUrl = bridgeUrl;
        s.defer = true;
        s.setAttribute(INJECT_FLAG, base);
        document.head.appendChild(s);
        console.log("[aiti-debug-inject] 注入目标 launcher：" + s.src);
      });
  }

  function removeInjected() {
    document.querySelectorAll('script[' + INJECT_FLAG + ']').forEach((el) => el.remove());
  }

  function apply() {
    const feats = (typeof ctx.getFeatures === "function" ? ctx.getFeatures() : {}) || {};
    const enabled = feats["inject.enabled"] === true;
    const baseUrl = typeof feats["service.url"] === "string" ? feats["service.url"].trim() : "";
    const key = (enabled && baseUrl) ? "1|" + baseUrl : "0|";
    if (appliedKey === key) return; // 无变化
    appliedKey = key;
    removeInjected(); // 切目标 / 关闭 → 先清旧 script，避免残留多个 launcher
    if (enabled && baseUrl) injectLauncher(baseUrl);
  }

  apply();
  // feature 变更（extman 改地址 / 切开关）→ 重新评估注入
  if (typeof ctx.onFeatureChange === "function") {
    ctx.onFeatureChange(() => { appliedKey = ""; apply(); });
  }

  try { console.log("[aiti-debug-inject] client 已挂载（纯注入，无 UI；feature: service.url + inject.enabled）"); } catch (e) {}
}
