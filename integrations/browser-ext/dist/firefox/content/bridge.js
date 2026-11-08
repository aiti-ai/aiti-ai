/*
 * aiti-devtools 浏览器扩展 · isolated world 配置桥（Chrome / Edge / Firefox）
 *
 * v2 职责：读 storage.sync 配置（含 v1 迁移）→ **站点规则求值**（denySites > defaultEnabled‖allowSites）
 *          → 把**解析结果**（enabled/bridgeUrl/aiUrl）写 localStorage（MAIN world 同步读）+ postMessage 实时广播。
 * 按需启用：popup「在本页启用（本次）」→ runtime.onMessage('aiti-ext:once') → 仅 postMessage 一条
 *          enabled:true 的覆盖 cfg（**纯运行时消息不落盘**）——MAIN world main.js 的常驻监听立即注入；
 *          新 document 重新按规则裁决，天然「本次」语义（硬导航失效、SPA 软路由保留）。
 */
(function () {
  'use strict';
  if (window.__aitiExtBridgeLoaded) return;
  window.__aitiExtBridgeLoaded = true;

  const LS_KEY = 'aiti-ext:cfg';
  const V2_DEFAULTS = {
    v: 2,
    defaultEnabled: false,        // ★ v2：默认关
    allowSites: [],
    denySites: [],
    aiTarget: { kind: 'cockpit', baseUrl: '', cockpitUrl: '' },
    bridgeUrl: 'http://127.0.0.1:8777/aiti',
  };
  const LEGACY_AI_DEFAULT = 'http://127.0.0.1:8777/cockpit.html';
  const api = globalThis.browser || globalThis.chrome;
  if (!api || !api.runtime || !api.runtime.id) return;

  function migrate(stored) { /* 与 sw.js 同款（独立运行时无共享模块） */
    stored = stored || {};
    const cfg = {
      v: 2,
      defaultEnabled: typeof stored.defaultEnabled === 'boolean' ? stored.defaultEnabled : V2_DEFAULTS.defaultEnabled,
      allowSites: Array.isArray(stored.allowSites) ? stored.allowSites : [],
      denySites: Array.isArray(stored.denySites) ? stored.denySites : [],
      aiTarget: stored.aiTarget && stored.aiTarget.kind ? stored.aiTarget : { kind: 'cockpit', baseUrl: '', cockpitUrl: '' },
      bridgeUrl: stored.bridgeUrl || V2_DEFAULTS.bridgeUrl,
    };
    if (stored.v !== 2) {
      if (typeof stored.enabled === 'boolean' && stored.defaultEnabled === undefined)
        cfg.defaultEnabled = stored.enabled;
      if ((!stored.denySites || !stored.denySites.length) && Array.isArray(stored.excludes) && stored.excludes.length && !cfg.allowSites.length)
        cfg.denySites = stored.excludes;
      if (stored.aiUrl && stored.aiUrl !== LEGACY_AI_DEFAULT && (!stored.aiTarget || !stored.aiTarget.kind))
        cfg.aiTarget = { kind: 'cockpit', baseUrl: '', cockpitUrl: stored.aiUrl };
    }
    return cfg;
  }

  function matchesAny(url, patterns) {
    for (let i = 0; i < (patterns || []).length; i++) {
      try { if (new RegExp(patterns[i]).test(url)) return true; } catch (e) {}
    }
    return false;
  }
  // 站点规则求值（denySites 优先于一切；default关时白名单命中才开）
  function autoEnabled(href, cfg) {
    if (matchesAny(href, cfg.denySites)) return false;
    return cfg.defaultEnabled || matchesAny(href, cfg.allowSites);
  }
  // AI 窗地址解析：pi-web/agent → baseUrl；cockpit → 显式 cockpitUrl 或 bridgeUrl origin 推导
  function resolveAiUrl(cfg) {
    const t = cfg.aiTarget || { kind: 'cockpit' };
    if ((t.kind === 'pi-web' || t.kind === 'agent') && t.baseUrl) return t.baseUrl;
    return t.cockpitUrl || cfg.bridgeUrl.replace(/\/+$/, '').replace(/\/aiti$/, '') + '/cockpit.html';
  }
  // 规则求值 → MAIN world 所需的解析结果
  function resolve(href, cfg) {
    return { v: 2, enabled: autoEnabled(href, cfg), bridgeUrl: cfg.bridgeUrl, aiUrl: resolveAiUrl(cfg) };
  }

  function save(cfg) { try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch (e) {} }
  function publish(cfg) { try { window.postMessage({ __aitiExt: 1, type: 'cfg', cfg: cfg }, '*'); } catch (e) {} }

  const read = () => new Promise((resolve) => {
    try { api.storage.sync.get(null, (items) => resolve(items || {})); }
    catch (e) { resolve({}); }
  });

  function apply(stored) {
    const cfg = migrate(stored);
    const resolved = resolve(location.href, cfg);
    save(resolved);
    publish(resolved);
  }

  read().then(apply);                                                          // 首次求值
  if (api.storage.onChanged) api.storage.onChanged.addListener((ch, area) => { // 配置变化实时重求值
    if (area === 'sync') read().then(apply);
  });

  // popup 按需启用（本次）：纯运行时覆盖，不落盘
  api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.__aitiExt !== 1) return;
    if (msg.type === 'aiti-ext:once') {
      read().then((stored) => {
        const cfg = migrate(stored);
        publish({ v: 2, enabled: true, bridgeUrl: cfg.bridgeUrl, aiUrl: resolveAiUrl(cfg) });
        try { sendResponse({ ok: true }); } catch (e) {}
      });
      return true; // async sendResponse
    }
  });
})();
