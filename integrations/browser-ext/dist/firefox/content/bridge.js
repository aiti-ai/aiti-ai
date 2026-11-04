/*
 * aiti-devtools 浏览器扩展 · isolated world 配置桥（Chrome / Edge / Firefox）
 *
 * 职责：读 storage.sync 配置 → 站点排除匹配 → 写 localStorage（MAIN world 同步读）+ postMessage
 *      （实时通知同页 MAIN world 注入器）。
 * 说明：localStorage 是跨 world（isolated/MAIN）共享的——本脚本异步读回配置后写入，MAIN world
 *      （document_idle）随后同步读到的即最新缓存（稳定态）；首次换配置有一轮延迟（见方案 D1）。
 */
(function () {
  'use strict';
  if (window.__aitiExtBridgeLoaded) return;
  window.__aitiExtBridgeLoaded = true;

  const LS_KEY = 'aiti-ext:cfg';
  const DEFAULTS = {
    enabled: true,
    bridgeUrl: 'http://127.0.0.1:8777/aiti',
    aiUrl: 'http://127.0.0.1:8777/cockpit.html',
    excludes: [],
  };
  const api = globalThis.browser || globalThis.chrome;
  if (!api || !api.runtime || !api.runtime.id) return; // 非扩展运行时（理论不达）

  function save(cfg) { try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch (e) {} }
  function publish(cfg) { try { window.postMessage({ __aitiExt: 1, type: 'cfg', cfg: cfg }, '*'); } catch (e) {} }
  function excluded(url, patterns) {
    for (let i = 0; i < (patterns || []).length; i++) {
      try { if (new RegExp(patterns[i]).test(url)) return true; } catch (e) {}
    }
    return false;
  }

  const read = () => new Promise((resolve) => {
    try { api.storage.sync.get(DEFAULTS, resolve); }
    catch (e) { resolve(Object.assign({}, DEFAULTS)); }
  });

  read().then((items) => {
    const cfg = Object.assign({}, DEFAULTS, items || {});
    if (excluded(location.href, cfg.excludes)) cfg.enabled = false;
    save(cfg);
    publish(cfg);
  });

  // options/popup 保存后主动推送：更新同页 localStorage 缓存 + 通知 MAIN world（launcher 已 boot 则刷新后生效）
  try {
    api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg && msg.__aitiExt === 1 && msg.type === 'cfg' && msg.cfg) {
        const cfg = Object.assign({}, DEFAULTS, msg.cfg);
        if (excluded(location.href, cfg.excludes)) cfg.enabled = false;
        save(cfg);
        publish(cfg);
        sendResponse({ ok: true });
      }
    });
  } catch (e) { /* Firefox 某些版本 onMessage 语义差异，忽略 */ }
})();