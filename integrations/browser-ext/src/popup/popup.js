/*
 * aiti-devtools browser extension · popup (v2)
 *
 * This-page state card (default off / allowlisted / denied / restricted page) + three buttons:
 *   ⚡ Enable on this page (once) — pure runtime injection (postMessage override, dies on navigation;
 *      explicit user action wins over rules)
 *   ★ Always enable this site — writes the current origin into the allowlist
 *   ⚙ Options
 * Shows the AI target (pi-web / compatible agent / cockpit) and opens the AI window.
 */
(function () {
  'use strict';
  const api = globalThis.browser || globalThis.chrome;
  const LEGACY_AI_DEFAULT = 'http://127.0.0.1:8777/cockpit.html';
  const RESTRICTED = /^(chrome|edge|about|browser|view-source):|^https:\/\/(chrome\.google\.com|chromewebstore\.google\.com)|^https:\/\/(addons\.mozilla|support\.mozilla)\.[a-z]+\//i;
  const $ = (id) => document.getElementById(id);

  function migrate(stored) {
    stored = stored || {};
    return {
      v: 2,
      defaultEnabled: typeof stored.defaultEnabled === 'boolean' ? stored.defaultEnabled : false,
      allowSites: Array.isArray(stored.allowSites) ? stored.allowSites : [],
      denySites: Array.isArray(stored.denySites) ? stored.denySites : [],
      aiTarget: stored.aiTarget && stored.aiTarget.kind ? stored.aiTarget : { kind: 'cockpit', baseUrl: '', cockpitUrl: '' },
      bridgeUrl: stored.bridgeUrl || 'http://127.0.0.1:8777/aiti',
      aiUrl: stored.aiUrl,
    };
  }
  function matchesAny(url, patterns) {
    for (const p of patterns || []) { try { if (new RegExp(p).test(url)) return true; } catch (e) {} }
    return false;
  }
  function resolveAiUrl(cfg) {
    const t = cfg.aiTarget || {};
    if ((t.kind === 'pi-web' || t.kind === 'agent') && t.baseUrl) return t.baseUrl;
    return t.cockpitUrl || cfg.bridgeUrl.replace(/\/+$/, '').replace(/\/aiti$/, '') + '/cockpit.html';
  }
  const KIND_LABEL = { 'pi-web': 'pi-web 工作台', 'agent': '兼容 agent 宿主', 'cockpit': 'cockpit 操作台（兜底）' };
  function setHint(text, cls) { const h = $('hint'); h.textContent = text; h.className = 'foot ' + (cls || ''); }

  let TAB = null, CFG = null, AUTO = false, DENIED = false;

  function render() {
    const url = TAB && TAB.url || '';
    const restricted = RESTRICTED.test(url);
    DENIED = matchesAny(url, CFG.denySites);
    AUTO = !DENIED && (CFG.defaultEnabled || matchesAny(url, CFG.allowSites));
    const t = CFG.aiTarget || {};
    $('siteState').textContent = restricted ? '此页面不支持注入'
      : DENIED ? '已被排除（自动注入关闭）'
      : AUTO ? '自动注入：开'
      : '自动注入：关（默认）';
    $('siteState').dataset.state = restricted ? 'restricted' : DENIED ? 'denied' : AUTO ? 'on' : 'off';
    $('aiTarget').textContent = KIND_LABEL[t.kind] || t.kind || 'cockpit';
    $('bridgeUrl').textContent = CFG.bridgeUrl || '—';
    $('once').disabled = restricted;
    $('always').disabled = restricted || AUTO;
    if (!restricted && !(CFG.aiTarget && CFG.aiTarget.baseUrl) && !(CFG.aiTarget && CFG.aiTarget.kind === 'cockpit' && CFG.aiTarget.cockpitUrl))
      setHint('未配置 AI 目标——点 ⚙ 设置探测本机 pi-web 或手填地址');
  }

  function load() {
    api.storage.sync.get(null, (stored) => {
      CFG = migrate(stored);
      api.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        TAB = (tabs || [])[0] || null;
        render();
      });
    });
  }

  // ⚡ once: tell the already-present content script to inject now (pure runtime message, gone on navigation)
  $('once').addEventListener('click', () => {
    if (!TAB || TAB.id == null) return;
    setHint('注入中…');
    try {
      api.tabs.sendMessage(TAB.id, { __aitiExt: 1, type: 'aiti-ext:once' }, (res) => {
        const err = api.runtime.lastError;
        if (err || !res || !res.ok) setHint('此页面不支持脚本注入（刷新页面后重试）', 'err');
        else setHint('已注入（本次）——导航后失效', 'ok');
        render();
      });
    } catch (e) { setHint('此页面不支持脚本注入', 'err'); }
  });

  // ★ always: write the current origin into the allowlist
  $('always').addEventListener('click', () => {
    if (!TAB || !TAB.url) return;
    let origin;
    try { origin = new URL(TAB.url).origin; } catch (e) { return; }
    const pattern = '^' + origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/';
    const list = (CFG.allowSites || []).slice();
    if (!list.includes(pattern)) list.push(pattern);
    CFG.allowSites = list;
    api.storage.sync.set({ allowSites: list }, () => {
      setHint('已加入白名单（刷新页面生效）', 'ok');
      render();
    });
  });

  $('openAi').addEventListener('click', () => {
    if (!CFG) return;
    api.tabs.create({ url: resolveAiUrl(CFG) });
  });
  $('openOptions').addEventListener('click', () => api.runtime.openOptionsPage());

  load();
})();
