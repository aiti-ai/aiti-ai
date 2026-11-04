/*
 * aiti-devtools 浏览器扩展 · MAIN world 注入器（Chrome / Edge / Firefox，含 Firefox Android）
 *
 * 职责：把 aiti-devtools launcher 注入任意页面（目标应用零改造）。
 *  - 注入方式：本 content script 以 world:"MAIN" 运行（manifest 声明），launcher 源码在
 *    构建时内联进本文件（LAUNCHER_CODE 占位符被替换为 launcher 源码），作为文件顶层代码执行——
 *    非 eval/Function，不受页面 CSP 约束（content script 文件代码由浏览器直接执行）。
 *  - 配置来源：localStorage 缓存（bridge.js isolated 写入）+ 默认值兜底 + postMessage 实时更新。
 *  - 防重复：window.__dbgLauncherInstalled（launcher 自带守卫，页面本身有 launcher 时不双注入）。
 */
(function () {
  'use strict';
  const LS_KEY = 'aiti-ext:cfg';
  const DEFAULTS = {
    enabled: true,
    bridgeUrl: 'http://127.0.0.1:8777/aiti',
    aiUrl: 'http://127.0.0.1:8777/cockpit.html',
  };

  function readCfg() {
    try {
      const v = localStorage.getItem(LS_KEY);
      return v ? JSON.parse(v) : null;
    } catch (e) { return null; }
  }

  function inject(cfg) {
    if (window.__dbgLauncherInstalled) return;   // 页面已有 launcher（如 pi-web）→ 不双注入
    if (!cfg || cfg.enabled === false) return;   // 站点被排除 / 开关关闭
    if (cfg.bridgeUrl) window.__AITI_BRIDGE_URL = cfg.bridgeUrl;
    if (cfg.aiUrl) window.__AITI_AI_URL = cfg.aiUrl;
    /*__LAUNCHER_CODE__*/
  }

  // 1) 同步注入：优先 localStorage 缓存（bridge.js isolated 已写入），无缓存用默认值
  inject(readCfg() || DEFAULTS);

  // 2) 异步配置（storage.sync 读回后 postMessage / options 保存后）→ 尚未注入则补注
  window.addEventListener('message', function (e) {
    const d = e && e.data;
    if (d && d.__aitiExt === 1 && d.type === 'cfg') inject(d.cfg);
  });
})();