/*
 * aiti-devtools 浏览器扩展 · popup
 */
(function () {
  'use strict';
  const api = globalThis.browser || globalThis.chrome;
  const DEFAULTS = {
    enabled: true,
    bridgeUrl: 'http://127.0.0.1:8777/aiti',
    aiUrl: 'http://127.0.0.1:8777/cockpit.html',
    excludes: [],
  };
  const $ = (id) => document.getElementById(id);

  function load() {
    api.storage.sync.get(DEFAULTS, (cfg) => {
      cfg = Object.assign({}, DEFAULTS, cfg || {});
      $('enabled').checked = cfg.enabled !== false;
      $('bridgeUrl').textContent = cfg.bridgeUrl || '—';
      $('aiUrl').textContent = cfg.aiUrl || '—';
      $('hint').textContent = cfg.enabled === false ? '注入已关闭' : '已启用：任意页面注入 launcher（刷新后生效）';
    });
  }

  $('enabled').addEventListener('change', (e) => {
    api.storage.sync.set({ enabled: e.target.checked }, () => {
      $('hint').textContent = e.target.checked ? '已启用（刷新页面生效）' : '已关闭（刷新页面停止注入）';
    });
  });

  $('openAi').addEventListener('click', () => {
    api.storage.sync.get(DEFAULTS, (cfg) => {
      const url = (cfg && cfg.aiUrl) || DEFAULTS.aiUrl;
      api.tabs.create({ url });
    });
  });

  $('openOptions').addEventListener('click', () => {
    api.runtime.openOptionsPage();
  });

  load();
})();