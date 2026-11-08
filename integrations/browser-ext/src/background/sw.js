/*
 * aiti-devtools browser extension · background service worker (Chrome / Edge / Firefox)
 *
 * Role: initialize/migrate config on install & upgrade (v2 schema: default-off + allow/deny site rules + aiTarget).
 * v1 → v2 migration map (semantics-preserving):
 *   enabled:true  → defaultEnabled:true
 *   excludes[]    → denySites[]
 *   bridgeUrl     → kept as-is
 *   aiUrl (default cockpit value) → aiTarget.kind=cockpit (URL derived from bridgeUrl)
 *   aiUrl (custom value)          → aiTarget.kind=cockpit + cockpitUrl=aiUrl
 */
const api = globalThis.browser || globalThis.chrome;

const V2_DEFAULTS = {
  v: 2,
  defaultEnabled: false,          // ★ v2: default off (allowlist / popup on-demand enable)
  allowSites: [],
  denySites: [],
  aiTarget: { kind: 'cockpit', baseUrl: '', cockpitUrl: '' },
  bridgeUrl: 'http://127.0.0.1:8777/aiti',
};
const LEGACY_AI_DEFAULT = 'http://127.0.0.1:8777/cockpit.html';

function migrate(stored) {
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
      cfg.aiTarget = { kind: 'cockpit', baseUrl: cfg.aiTarget.baseUrl || '', cockpitUrl: stored.aiUrl };
  }
  return cfg;
}

api.runtime.onInstalled.addListener(() => {
  try {
    api.storage.sync.get(null, (cur) => {
      api.storage.sync.set(migrate(cur || {}));
    });
  } catch (e) { /* install-init failure must not block */ }
});
