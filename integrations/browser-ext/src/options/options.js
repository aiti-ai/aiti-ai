/*
 * aiti-devtools browser extension · options (v2)
 *
 * Site rules (default off + allowlist/deny) + AI target (pi-web probe prefill / compatible agent / cockpit fallback) + advanced (bridge URL / shim).
 * v1 legacy config is mapped by migrate() (enabled→defaultEnabled, excludes→denySites, custom aiUrl→cockpitUrl).
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
      // notify every tab's content script to re-evaluate (storage.onChanged also fires — belt and braces)
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

  // probe local pi-web: HEAD /aiti/aiti-launcher.js (host_permissions <all_urls> allows the cross-origin call)
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
