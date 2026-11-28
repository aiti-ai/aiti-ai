/**
 * OAuth landing page served by server.middleware at:
 *   /<basePath?>/aiti-codehub/oauth/<platform>
 *
 * The page is intentionally NOT under /api (pi-web's cross-site gate would block the
 * provider's redirect). It reads code/state, clears the query string, then POSTs to the
 * same-origin exchange endpoint and renders the result.
 */
export function landingHtml(providerId: string): string {
  const p = JSON.stringify(providerId);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CodeHub · OAuth</title><style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#111;color:#eee;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{max-width:560px;padding:28px 32px;border:1px solid #333;border-radius:12px;background:#1a1a1a}
h1{font-size:18px;margin:0 0 10px;color:#e5e5e5}p{font-size:13px;line-height:1.6;color:#bbb;margin:6px 0}
.ok{color:#34d399}.err{color:#f87171}.dim{color:#777;font-size:11.5px}
</style></head><body><div class="card"><h1>CodeHub Authorization</h1><p id="msg">Finishing authorization…</p><p class="dim" id="detail"></p></div>
<script>
(function () {
  var provider = ${p};
  var q = new URLSearchParams(location.search);
  var msg = document.getElementById('msg');
  var detail = document.getElementById('detail');
  var err = q.get('error');
  var desc = q.get('error_description') || err;
  if (err) {
    msg.className = 'err'; msg.textContent = 'Authorization failed: ' + desc;
    history.replaceState(null, '', location.pathname);
    return;
  }
  var code = q.get('code'), state = q.get('state');
  history.replaceState(null, '', location.pathname);
  if (!code || !state) { msg.className = 'err'; msg.textContent = 'Missing code / state parameters.'; return; }
  var base = location.pathname.replace(/\\/aiti-codehub\\/oauth\\/[^/]+$/, '');
  fetch(base + '/api/extensions/aiti-codehub/oauth/' + encodeURIComponent(provider) + '/exchange', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: code, state: state })
  }).then(function (r) { return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }); })
    .then(function (d) {
      if (d && d.ok) { msg.className = 'ok'; msg.textContent = 'Authorization complete — you can close this page and return to pi-web.'; setTimeout(function () { try { window.close(); } catch (e) {} }, 1200); }
      else { msg.className = 'err'; msg.textContent = 'Authorization failed: ' + ((d && d.error) || 'unknown error'); }
    }).catch(function (e) { msg.className = 'err'; msg.textContent = 'Authorization failed: ' + (e && e.message ? e.message : e); });
})();
</script></body></html>`;
}
