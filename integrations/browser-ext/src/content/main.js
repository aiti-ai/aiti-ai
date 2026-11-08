/*
 * aiti-devtools browser extension · MAIN-world injector (Chrome / Edge / Firefox, incl. Firefox Android)
 *
 * Role: inject the aiti-devtools launcher into any page (zero changes to the target app).
 *  - Injection: this content script runs with world:"MAIN" (declared in the manifest); the launcher
 *    source is inlined into this file at build time (the LAUNCHER_CODE placeholder is replaced with
 *    the launcher source) and executes as file top-level code — not eval/Function, unconstrained
 *    by page CSP (content script files are executed directly by the browser).
 *  - Config source: localStorage cache (written by bridge.js in the isolated world) + default
 *    fallback + live updates via postMessage.
 *  - Double-injection guard: window.__dbgLauncherInstalled (the launcher's own sentinel — no double
 *    injection when the page already runs a launcher).
 */
(function () {
  'use strict';
  const LS_KEY = 'aiti-ext:cfg';
  const DEFAULTS = {
    enabled: false,   // ★ v2 default off (true only after bridge.js resolves the site rules; 'once' overrides via postMessage)
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
    if (window.__dbgLauncherInstalled) return;   // page already has a launcher (e.g. pi-web) → no double injection
    if (!cfg || cfg.enabled === false) return;   // site denied / switch off
    if (cfg.bridgeUrl) window.__AITI_BRIDGE_URL = cfg.bridgeUrl;
    if (cfg.aiUrl) window.__AITI_AI_URL = cfg.aiUrl;
    /*__LAUNCHER_CODE__*/
  }

  // 1) synchronous inject: prefer the localStorage cache (written by bridge.js in the isolated world); fall back to defaults
  inject(readCfg() || DEFAULTS);

  // 2) async config (storage.sync read-back posted via postMessage / options save) → inject now if not yet injected
  window.addEventListener('message', function (e) {
    const d = e && e.data;
    if (d && d.__aitiExt === 1 && d.type === 'cfg') inject(d.cfg);
  });
})();