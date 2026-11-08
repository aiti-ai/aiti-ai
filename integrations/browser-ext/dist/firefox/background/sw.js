/*
 * aiti-devtools 浏览器扩展 · background service worker（Chrome / Edge / Firefox）
 *
 * 职责：安装/升级时初始化与迁移配置（v2 schema：默认关 + 白名单/排除 + aiTarget）。
 * v2 迁移映射（legacy v1 → v2，语义等价）：
 *   enabled:true  → defaultEnabled:true
 *   excludes[]    → denySites[]
 *   bridgeUrl     → 原样
 *   aiUrl（默认 cockpit 值）      → aiTarget.kind=cockpit（URL 由 bridgeUrl 推导）
 *   aiUrl（自定义值）             → aiTarget.kind=cockpit + cockpitUrl=aiUrl
 */
const api = globalThis.browser || globalThis.chrome;

const V2_DEFAULTS = {
  v: 2,
  defaultEnabled: false,          // ★ v2：默认关（白名单 / popup 按需启用）
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
  } catch (e) { /* 安装初始化失败不阻塞 */ }
});
