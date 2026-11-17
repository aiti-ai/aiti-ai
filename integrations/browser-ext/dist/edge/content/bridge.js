/*
 * aiti-devtools browser extension · isolated-world config bridge (Chrome / Edge / Firefox)
 *
 * v2 role: read storage.sync config (incl. v1 migration) → **site-rule evaluation**
 *          (denySites > defaultEnabled||allowSites) → write the **resolved** result
 *          (enabled/bridgeUrl/aiUrl) to localStorage (synchronous read by MAIN world) + postMessage live update.
 * On-demand: popup "Enable on this page (once)" → runtime.onMessage('aiti-ext:once') → posts a single
 *          enabled:true override cfg (**pure runtime message, nothing persisted**) — the always-on listener
 *          in MAIN-world main.js injects immediately; every new document re-evaluates the rules, which is
 *          the natural "once" semantics (dies on hard navigation, survives SPA soft routing).
 */
(function () {
  'use strict';
  if (window.__aitiExtBridgeLoaded) return;
  window.__aitiExtBridgeLoaded = true;

  const LS_KEY = 'aiti-ext:cfg';
  const V2_DEFAULTS = {
    v: 2,
    defaultEnabled: false,        // ★ v2: default off
    allowSites: [],
    denySites: [],
    aiTarget: { kind: 'cockpit', baseUrl: '', cockpitUrl: '' },
    bridgeUrl: 'http://127.0.0.1:8777/aiti',
  };
  const LEGACY_AI_DEFAULT = 'http://127.0.0.1:8777/cockpit.html';
  const api = globalThis.browser || globalThis.chrome;
  if (!api || !api.runtime || !api.runtime.id) return;

  function migrate(stored) { /* same as sw.js (no shared module across isolated runtimes) */
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
  // site-rule evaluation (denySites wins over everything; with default-off, allowlist hit enables)
  function autoEnabled(href, cfg) {
    if (matchesAny(href, cfg.denySites)) return false;
    return cfg.defaultEnabled || matchesAny(href, cfg.allowSites);
  }
  // AI window URL resolution: pi-web/agent → baseUrl; cockpit → explicit cockpitUrl or derived from bridgeUrl origin
  function resolveAiUrl(cfg) {
    const t = cfg.aiTarget || { kind: 'cockpit' };
    if ((t.kind === 'pi-web' || t.kind === 'agent') && t.baseUrl) return t.baseUrl;
    return t.cockpitUrl || cfg.bridgeUrl.replace(/\/+$/, '').replace(/\/aiti$/, '') + '/cockpit.html';
  }
  // rule evaluation → the resolved result the MAIN world needs
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

  read().then(apply);                                                          // first evaluation
  if (api.storage.onChanged) api.storage.onChanged.addListener((ch, area) => { // re-evaluate live on config change
    if (area === 'sync') read().then(apply);
  });

  // popup on-demand enable (once): pure runtime override, nothing persisted
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
