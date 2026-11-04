/*
 * aiti-devtools 浏览器扩展 · options
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

  function setStatus(text, cls) {
    $('status').textContent = text;
    $('status').className = 'status ' + (cls || '');
  }
  function updateShimUrl() {
    const b = $('bridgeUrl').value.trim();
    $('shimUrl').textContent = b || '—';
  }

  function load() {
    api.storage.sync.get(DEFAULTS, (cfg) => {
      cfg = Object.assign({}, DEFAULTS, cfg || {});
      $('enabled').checked = cfg.enabled !== false;
      $('bridgeUrl').value = cfg.bridgeUrl || '';
      $('aiUrl').value = cfg.aiUrl || '';
      $('excludes').value = (cfg.excludes || []).join('\n');
      updateShimUrl();
    });
  }

  function save() {
    const excludes = $('excludes').value.split('\n').map((s) => s.trim()).filter(Boolean);
    const cfg = {
      enabled: $('enabled').checked,
      bridgeUrl: $('bridgeUrl').value.trim() || DEFAULTS.bridgeUrl,
      aiUrl: $('aiUrl').value.trim() || DEFAULTS.aiUrl,
      excludes,
    };
    api.storage.sync.set(cfg, () => {
      // 通知各 tab content script 刷新缓存（localStorage），并使已有页面即时感知
      try { api.tabs.query({}, (tabs) => { (tabs || []).forEach((t) => { if (t.id != null) api.tabs.sendMessage(t.id, { __aitiExt: 1, type: 'cfg', cfg }).catch(() => {}); }); }); } catch (e) {}
      updateShimUrl();
      setStatus('已保存（刷新页面后生效）', 'ok');
      setTimeout(() => setStatus('', ''), 3000);
    });
  }

  function reset() {
    api.storage.sync.set(DEFAULTS, () => {
      load();
      setStatus('已恢复默认', 'ok');
      setTimeout(() => setStatus('', ''), 2000);
    });
  }

  $('bridgeUrl').addEventListener('input', updateShimUrl);
  $('save').addEventListener('click', save);
  $('reset').addEventListener('click', reset);
  $('copyShim').addEventListener('click', () => {
    navigator.clipboard.writeText($('shimUrl').textContent).then(
      () => setStatus('已复制', 'ok'),
      () => setStatus('复制失败（请手动复制）', 'err')
    );
  });

  load();
})();