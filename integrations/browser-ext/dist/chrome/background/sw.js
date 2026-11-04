/*
 * aiti-devtools 浏览器扩展 · background service worker（Chrome / Edge / Firefox）
 *
 * 职责：安装时初始化默认配置（不覆盖已有）；后续可扩展右键菜单/桥探测。
 */
const api = globalThis.browser || globalThis.chrome;

const DEFAULTS = {
  enabled: true,
  bridgeUrl: 'http://127.0.0.1:8777/aiti',
  aiUrl: 'http://127.0.0.1:8777/cockpit.html',
  excludes: [],
};

api.runtime.onInstalled.addListener(() => {
  try {
    api.storage.sync.get(DEFAULTS, (cur) => {
      api.storage.sync.set(Object.assign({}, DEFAULTS, cur || {}));
    });
  } catch (e) { /* 安装初始化失败不阻塞 */ }
});