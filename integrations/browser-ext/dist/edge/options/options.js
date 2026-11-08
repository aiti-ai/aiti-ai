/*
 * aiti-devtools 浏览器扩展 · options（v2）
 *
 * 站点规则（默认关 + 白名单/排除）+ AI 目标（pi-web 探测预填 / 兼容 agent / cockpit 兜底）+ 高级（桥地址 / shim）。
 * v1 legacy 配置由 migrate() 读取映射（enabled→defaultEnabled、excludes→denySites、自定义 aiUrl→cockpitUrl）。
 */
(function () {
  'use strict';
  const api = globalThis.browser || globalThis.chrome;
  const V2_DEFAULTS = {
    v: 2,
    defaultEnabled: false,
    allowSites: [],
    denySites: [],
    aiTarget: { kind: 'cockpit', baseUrl: '', cockpitUrl: '' },
    bridgeUrl: 'http://127.0.0.1:8777/aiti',
  };
  const LEGACY_AI_DEFAULT = 'http://127.0.0.1:8777/cockpit.html';
  const $ = (id) => document.getElementById(id);

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
        cfg.aiTarget = { kind: 'cockpit', baseUrl: '', cockpitUrl: stored.aiUrl };
    }
    return cfg;
  }

  function setStatus(text, cls) { $('status').textContent = text; $('status').className = 'status ' + (cls || ''); }
  function setProbe(text) { $('probeStatus').textContent = text; }
  function updateShimUrl() { $('shimUrl').textContent = $('bridgeUrl').value.trim() || '—'; }
  function syncKindUi() {
    const checked = document.querySelector('input[name="aiKind"]:checked');
    const k = checked ? checked.value : 'cockpit';
    $('cockpitUrlField').style.display = (k === 'cockpit') ? '' : 'none';
  }

  function fill(cfg) {
    document.querySelectorAll('input[name="aiKind"]').forEach((r) => { r.checked = r.value === (cfg.aiTarget.kind || 'cockpit'); });
    $('aiBaseUrl').value = cfg.aiTarget.baseUrl || '';
    $('cockpitUrl').value = cfg.aiTarget.cockpitUrl || '';
    $('defaultEnabled').checked = cfg.defaultEnabled === true;
    $('allowSites').value = (cfg.allowSites || []).join('\n');
    $('denySites').value = (cfg.denySites || []).join('\n');
    $('bridgeUrl').value = cfg.bridgeUrl || '';
    updateShimUrl();
    syncKindUi();
  }

  function collect() {
    const checked = document.querySelector('input[name="aiKind"]:checked');
    const kind = checked ? checked.value : 'cockpit';
    const toList = (v) => v.split('\n').map((x) => x.trim()).filter(Boolean);
    return {
      v: 2,
      defaultEnabled: $('defaultEnabled').checked,
      allowSites: toList($('allowSites').value),
      denySites: toList($('denySites').value),
      aiTarget: {
        kind: kind,
        baseUrl: $('aiBaseUrl').value.trim(),
        cockpitUrl: $('cockpitUrl').value.trim(),
      },
      bridgeUrl: $('bridgeUrl').value.trim() || V2_DEFAULTS.bridgeUrl,
    };
  }

  function load() {
    api.storage.sync.get(null, (stored) => fill(migrate(stored || {})));
  }

  function save() {
    const cfg = collect();
    api.storage.sync.set(cfg, () => {
      // 通知各 tab content script 重求值（storage.onChanged 亦会触发，双保险）
      try {
        api.tabs.query({}, (tabs) => {
          (tabs || []).forEach((t) => {
            if (t.id != null) { try { api.tabs.sendMessage(t.id, { __aitiExt: 1, type: 'cfg', cfg: cfg }).catch(function () {}); } catch (e) {} }
          });
        });
      } catch (e) {}
      updateShimUrl();
      setStatus('已保存（刷新页面后生效）', 'ok');
      setTimeout(() => setStatus('', ''), 3000);
    });
  }

  // 探测本机 pi-web：HEAD /aiti/aiti-launcher.js（host_permissions <all_urls> 放行跨源）
  function probe() {
    setProbe('探测中…');
    const ports = ['30141', '30142'];
    let i = 0;
    const tryNext = () => {
      if (i >= ports.length) { setProbe('未发现本机 pi-web（30141/30142）——可手填地址或用 cockpit 兜底'); return; }
      const base = 'http://127.0.0.1:' + ports[i++];
      fetch(base + '/aiti/aiti-launcher.js', { method: 'HEAD' })
        .then((r) => {
          if (r.ok) {
            $('aiKindPiweb').checked = true;
            $('aiBaseUrl').value = base;
            $('bridgeUrl').value = base + '/aiti';
            syncKindUi(); updateShimUrl();
            setProbe('✓ 已发现本机 pi-web：' + base + '（记得保存）');
          } else tryNext();
        })
        .catch(tryNext);
    };
    tryNext();
  }

  document.querySelectorAll('input[name="aiKind"]').forEach((r) => r.addEventListener('change', syncKindUi));
  $('bridgeUrl').addEventListener('input', updateShimUrl);
  $('probe').addEventListener('click', probe);
  $('copyShim').addEventListener('click', () => {
    try { navigator.clipboard.writeText($('shimUrl').textContent); setStatus('已复制', 'ok'); setTimeout(() => setStatus('', ''), 2000); } catch (e) {}
  });
  $('save').addEventListener('click', save);
  $('reset').addEventListener('click', () => { fill(Object.assign({}, V2_DEFAULTS)); save(); });

  load();
})();
